import fsp from 'node:fs/promises';
import { readStoredFile } from '../../../../../../lib/nvidia/cosmos.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Serves generated videos (kind=out) and uploaded reference media (kind=up),
// with Range support so <video> seeking works.
export async function GET(request, { params }) {
    const { kind, id } = await params;
    const info = await readStoredFile(kind, id);
    if (!info) return new Response('Not found', { status: 404 });

    const range = request.headers.get('range')?.match(/bytes=(\d*)-(\d*)/);
    let start = 0;
    let end = info.size - 1;
    let status = 200;
    if (range) {
        if (range[1] !== '') start = parseInt(range[1], 10);
        if (range[2] !== '') end = Math.min(parseInt(range[2], 10), end);
        if (range[1] === '' && range[2] !== '') {
            start = Math.max(0, info.size - parseInt(range[2], 10));
            end = info.size - 1;
        }
        if (start > end || start >= info.size) {
            return new Response('Range not satisfiable', {
                status: 416,
                headers: { 'Content-Range': `bytes */${info.size}` },
            });
        }
        status = 206;
    }

    const length = end - start + 1;
    const handle = await fsp.open(info.file, 'r');
    try {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        const headers = {
            'Content-Type': info.mime,
            'Content-Length': String(length),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=3600',
        };
        if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
        return new Response(buffer, { status, headers });
    } finally {
        await handle.close();
    }
}
