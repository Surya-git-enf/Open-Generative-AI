# NVIDIA NIM video generation (Cosmos3 Nano)

Video generation for the **Cosmos3 Nano (NVIDIA)** models runs through a server-side adapter
(`lib/nvidia/cosmos.js`) instead of Muapi. The frontend contract is unchanged.

## Setup

1. Create a key at https://build.nvidia.com (it starts with `nvapi-`).
2. **Codespaces:** GitHub repo > Settings > Secrets and variables > Codespaces > New repository secret,
   name `NVIDIA_API_KEY`. Or personal: github.com/settings/codespaces > Secrets. Rebuild/restart the Codespace.
   **Local:** copy `.env.example` to `.env.local` and set `NVIDIA_API_KEY`.
3. `npm run dev`. With the key set, the Muapi key prompt is skipped.

## Modes
- Text to video, image to video, and video to video (reference video).
- Reference videos are uploaded to `.nvidia-data/uploads` and sent to NVIDIA inline (base64),
  so the Codespace port does not need to be public. Use short H.264 MP4 clips.
- Results are saved to `.nvidia-data/outputs` and served from `/api/nvidia/file/out/<id>.mp4`.

## Notes
- Hosted endpoint is a trial/preview service; output carries a mandatory SynthID watermark.
- Jobs are tracked in memory and on disk; a server restart fails any in-flight job.
- Other Muapi features (images, lipsync, agents) still use Muapi.
