import { nvidiaEnabled } from '../../../../lib/nvidia/cosmos.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Tells the UI whether the server has NVIDIA_API_KEY (never returns the key).
export async function GET() {
    return Response.json({ configured: nvidiaEnabled() });
}
