// Server-only NVIDIA NIM adapter (Cosmos3 Nano) that keeps the existing
// Muapi-style contract the frontend already speaks:
//   POST predictions endpoint  -> { request_id, status }
//   GET  predictions/{id}/result -> { status, outputs:[url], url, error }
// NVIDIA's hosted endpoint is synchronous (MP4 as base64 in the response), so
// each request becomes a background job whose result is saved to disk and
// served back through /api/nvidia/file/out/<id>.mp4.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const NIM_URL =
    process.env.NVIDIA_COSMOS_URL ||
    'https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano';
const NVCF_STATUS_URL = 'https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/';
const DATA_DIR = process.env.NVIDIA_DATA_DIR || path.join(process.cwd(), '.nvidia-data');
const TIMEOUT_MS = Number(process.env.NVIDIA_TIMEOUT_MS) || 15 * 60 * 1000;
const STEPS = Number(process.env.NVIDIA_COSMOS_STEPS) || 35;
const FPS = 24;
const MAX_UPLOAD_BYTES = (Number(process.env.NVIDIA_MAX_UPLOAD_MB) || 100) * 1024 * 1024;

const MODEL_ENDPOINT = /^nvidia-cosmos3-nano-(t2v|i2v|v2v)$/;
const MODE_BY_SUFFIX = { t2v: 'text2video', i2v: 'image2video', v2v: 'video2video' };
const MAX_FRAMES = { 256: 397, 480: 297, 720: 197 };
const ASPECTS = { '16_9': 16 / 9, '9_16': 9 / 16, '1_1': 1, '4_3': 4 / 3, '3_4': 3 / 4 };
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

const store = (globalThis.__nvidiaStore ||= { jobs: new Map(), running: new Set() });

export const nvidiaEnabled = () => Boolean(process.env.NVIDIA_API_KEY);

const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

const dir = (...p) => path.join(DATA_DIR, ...p);
async function ensureDirs() {
    await Promise.all(['jobs', 'outputs', 'uploads'].map((d) => fsp.mkdir(dir(d), { recursive: true })));
}
const newId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function saveJob(job) {
    store.jobs.set(job.id, job);
    await ensureDirs();
    await fsp.writeFile(dir('jobs', `${job.id}.json`), JSON.stringify(job));
}

async function loadJob(id) {
    if (!SAFE_ID.test(id)) return null;
    if (store.jobs.has(id)) return store.jobs.get(id);
    try {
        const job = JSON.parse(await fsp.readFile(dir('jobs', `${id}.json`), 'utf8'));
        store.jobs.set(id, job);
        return job;
    } catch {
        return null;
    }
}

export function requestOrigin(request) {
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
    const proto =
        request.headers.get('x-forwarded-proto') ||
        (host && /^(localhost|127\.)/.test(host) ? 'http' : 'https');
    return host ? `${proto}://${host}` : new URL(request.url).origin;
}

// ---------- media helpers ----------

function sniffMp4Size(buf) {
    // Reads the first video-track `tkhd` box. Returns { width, height } or null.
    const walk = (start, end) => {
        let pos = start;
        while (pos + 8 <= end) {
            let size = buf.readUInt32BE(pos);
            const type = buf.toString('latin1', pos + 4, pos + 8);
            let hdr = 8;
            if (size === 1) {
                size = Number(buf.readBigUInt64BE(pos + 8));
                hdr = 16;
            } else if (size === 0) size = end - pos;
            if (size < hdr) return null;
            const boxEnd = Math.min(pos + size, end);
            if (type === 'moov' || type === 'trak') {
                const r = walk(pos + hdr, boxEnd);
                if (r) return r;
            } else if (type === 'tkhd') {
                const p = pos + hdr;
                const v1 = buf[p] === 1;
                const matrix = p + (v1 ? 52 : 40);
                const dim = p + (v1 ? 88 : 76);
                let w = buf.readUInt32BE(dim) / 65536;
                let h = buf.readUInt32BE(dim + 4) / 65536;
                const a = buf.readInt32BE(matrix);
                const d = buf.readInt32BE(matrix + 16);
                if (a === 0 && d === 0) [w, h] = [h, w]; // 90/270 degree rotation
                if (w > 0 && h > 0) return { width: w, height: h };
            }
            pos += size;
        }
        return null;
    };
    try {
        return walk(0, buf.length);
    } catch {
        return null;
    }
}

function nearestAspect(width, height) {
    const r = width / height;
    let best = '16_9';
    let bestDiff = Infinity;
    for (const [key, val] of Object.entries(ASPECTS)) {
        const diff = Math.abs(Math.log(r / val));
        if (diff < bestDiff) [best, bestDiff] = [key, diff];
    }
    return best;
}

const LOCAL_REF = /\/api\/nvidia\/file\/up\/([A-Za-z0-9_-]+)/;

// Local uploads are inlined as data URIs so NVIDIA never needs to reach this
// machine (Codespaces ports are private by default). Public URLs pass through.
async function resolveMedia(ref, fallbackMime) {
    if (!ref || typeof ref !== 'string') return null;
    const local = ref.match(LOCAL_REF);
    if (local) {
        const id = local[1];
        const buf = await fsp.readFile(dir('uploads', id));
        let mime = fallbackMime;
        try {
            mime = JSON.parse(await fsp.readFile(dir('uploads', `${id}.json`), 'utf8')).mime || mime;
        } catch {}
        return { value: `data:${mime};base64,${buf.toString('base64')}`, buf };
    }
    return { value: ref, buf: null };
}

function tierOf(resolution) {
    const m = String(resolution || '').match(/(256|480|720)/);
    return m ? m[1] : '480';
}

function framesFor(duration, tier) {
    const seconds = Number(duration) || 5;
    let frames = Math.round(seconds * FPS) + 1;
    frames = Math.max(25, Math.min(MAX_FRAMES[tier], frames));
    return frames - ((frames - 1) % 4); // NIM frame counts follow 4k+1
}

async function buildNimPayload(suffix, p) {
    const mode = MODE_BY_SUFFIX[suffix];
    const tier = tierOf(p.resolution);
    let aspect = String(p.aspect_ratio || '16:9').replace(':', '_');
    if (!ASPECTS[aspect]) aspect = '16_9';

    const body = {
        model_mode: mode,
        resolution: `${tier}_${aspect}`,
        num_frames: framesFor(p.duration, tier),
        num_inference_steps: STEPS,
        fps: FPS,
    };
    if (p.prompt && String(p.prompt).trim()) body.prompt = String(p.prompt).trim();
    if (Number.isInteger(p.seed) && p.seed >= 0) body.seed = p.seed;

    if (suffix === 't2v') {
        if (!body.prompt) throw new Error('Prompt is required for text-to-video.');
    } else if (suffix === 'i2v') {
        const media = await resolveMedia(p.image_url || p.images_list?.[0], 'image/jpeg');
        if (!media) throw new Error('A reference image is required for image-to-video.');
        body.input_reference = media.value;
    } else {
        const media = await resolveMedia(p.video_url || p.videos_list?.[0], 'video/mp4');
        if (!media) throw new Error('A reference video is required for video-to-video.');
        body.input_reference = media.value;
        // Match the output aspect ratio to the reference clip when we can read it.
        const size = media.buf && sniffMp4Size(media.buf);
        if (size) {
            body.resolution = `${tier}_${nearestAspect(size.width, size.height)}`;
        }
    }
    return body;
}

// ---------- NVIDIA call + job runner ----------

function pickVideo(data) {
    if (!data || typeof data !== 'object') return {};
    const b64 = data.b64_video || data.data?.[0]?.b64_video;
    const url = data.video_url || data.url || data.output?.url;
    return { b64, url: typeof url === 'string' && /^https?:/.test(url) ? url : null };
}

async function callNim(body, job) {
    const key = process.env.NVIDIA_API_KEY;
    const auth = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
    const deadline = Date.now() + TIMEOUT_MS;
    const signal = AbortSignal.timeout(TIMEOUT_MS);

    let res = await fetch(NIM_URL, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });

    if (res.status === 202) {
        const reqId = res.headers.get('nvcf-reqid');
        if (!reqId) throw new Error('NVIDIA returned 202 without a request id, so the result cannot be polled.');
        job.nvcf_reqid = reqId;
        await saveJob(job);
        while (res.status === 202) {
            if (Date.now() > deadline) throw new Error('Timed out waiting for NVIDIA to finish.');
            await sleep(5000);
            res = await fetch(NVCF_STATUS_URL + reqId, { headers: auth, signal });
        }
    }

    if (!res.ok) {
        const text = (await res.text()).slice(0, 400);
        const hint =
            res.status === 401 || res.status === 403
                ? ' Check NVIDIA_API_KEY.'
                : res.status === 422
                  ? ' (invalid parameters or a safety refusal)'
                  : res.status === 429
                    ? ' (rate or trial limit reached)'
                    : '';
        throw new Error(`NVIDIA ${res.status}${hint}: ${text}`);
    }
    return res;
}

async function runJob(job, suffix, params) {
    store.running.add(job.id);
    try {
        const body = await buildNimPayload(suffix, params);
        const res = await callNim(body, job);
        const type = res.headers.get('content-type') || '';
        let bytes;

        if (type.includes('video/mp4')) {
            bytes = Buffer.from(await res.arrayBuffer());
        } else if (type.includes('json')) {
            const { b64, url } = pickVideo(await res.json());
            if (b64) bytes = Buffer.from(b64, 'base64');
            else if (url) {
                // Signed download URL: never send the NVIDIA bearer token to it.
                const dl = await fetch(url);
                if (!dl.ok) throw new Error(`Result download failed: ${dl.status}`);
                bytes = Buffer.from(await dl.arrayBuffer());
            }
        }
        if (!bytes || bytes.length < 1000) {
            throw new Error(`NVIDIA returned no video (content-type: ${type || 'unknown'}).`);
        }

        await ensureDirs();
        await fsp.writeFile(dir('outputs', `${job.id}.mp4`), bytes);
        job.status = 'completed';
        job.output = `/api/nvidia/file/out/${job.id}.mp4`;
        job.request = { ...body, input_reference: body.input_reference ? '[omitted]' : undefined };
    } catch (err) {
        job.status = 'failed';
        job.error = err?.name === 'TimeoutError' ? 'Timed out waiting for NVIDIA.' : err?.message || String(err);
    } finally {
        store.running.delete(job.id);
        job.finished = Date.now();
        await saveJob(job).catch(() => {});
    }
}

// ---------- handlers used by the catch-all proxy route ----------

async function handleSubmit(request, suffix) {
    if (!nvidiaEnabled()) {
        return json({ error: 'NVIDIA_API_KEY is not set on the server.' }, 500);
    }
    let params;
    try {
        params = await request.json();
    } catch {
        return json({ error: 'Invalid JSON body.' }, 400);
    }
    const job = { id: newId('nvd'), status: 'processing', mode: suffix, created: Date.now() };
    await saveJob(job);
    void runJob(job, suffix, params); // background; client polls for the result
    return json({ request_id: job.id, id: job.id, status: 'processing' });
}

async function handleUpload(request) {
    let file;
    try {
        file = (await request.formData()).get('file');
    } catch {
        return json({ error: 'Expected multipart form data with a "file" field.' }, 400);
    }
    if (!file || typeof file.arrayBuffer !== 'function') {
        return json({ error: 'No file provided.' }, 400);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
        return json({ error: `File too large (limit ${MAX_UPLOAD_BYTES / 1048576} MB).` }, 413);
    }
    const id = newId('up');
    await ensureDirs();
    await fsp.writeFile(dir('uploads', id), Buffer.from(await file.arrayBuffer()));
    await fsp.writeFile(
        dir('uploads', `${id}.json`),
        JSON.stringify({ mime: file.type || 'application/octet-stream', name: file.name, size: file.size })
    );
    const url = `${requestOrigin(request)}/api/nvidia/file/up/${id}`;
    return json({ url, file_url: url });
}

async function handleResult(request, id) {
    const job = await loadJob(id);
    if (!job) return json({ error: 'Unknown request id.' }, 404);
    if (job.status === 'processing' && !store.running.has(id)) {
        job.status = 'failed';
        job.error = 'The server restarted while this video was generating. Please submit it again.';
        await saveJob(job);
    }
    const out = { request_id: id, id, status: job.status };
    if (job.status === 'completed') {
        const url = `${requestOrigin(request)}${job.output}`;
        out.outputs = [url];
        out.url = url;
    }
    if (job.status === 'failed') {
        out.error = job.error;
        out.message = job.error;
    }
    return json(out);
}

export async function handleNvidiaPost(request, pathStr) {
    const m = pathStr.match(MODEL_ENDPOINT);
    if (m) return handleSubmit(request, m[1]);
    if (/^models\/nvidia-cosmos3-nano-(t2v|i2v|v2v)\/estimate-cost$/.test(pathStr)) {
        return json({ cost: 0, credits: 0 });
    }
    if (pathStr === 'upload_file' && nvidiaEnabled()) return handleUpload(request);
    return null;
}

export async function handleNvidiaGet(request, pathStr) {
    const m = pathStr.match(/^predictions\/(nvd_[A-Za-z0-9]+)\/result$/);
    if (m) return handleResult(request, m[1]);
    if (pathStr === 'account/balance' && request.headers.get('x-api-key') === 'server-managed') {
        return json({ balance: null, provider: 'nvidia' });
    }
    return null;
}

export async function readStoredFile(kind, id) {
    if (!SAFE_ID.test(id.replace(/\.mp4$/, ''))) return null;
    const folder = kind === 'out' ? 'outputs' : kind === 'up' ? 'uploads' : null;
    if (!folder) return null;
    const file = dir(folder, id);
    let mime = kind === 'out' ? 'video/mp4' : 'application/octet-stream';
    if (kind === 'up') {
        try {
            mime = JSON.parse(await fsp.readFile(dir('uploads', `${id}.json`), 'utf8')).mime || mime;
        } catch {}
    }
    try {
        const stat = await fsp.stat(file);
        return { file, size: stat.size, mime };
    } catch {
        return null;
    }
}
