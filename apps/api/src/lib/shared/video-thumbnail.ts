// A video's thumbnail source: ffprobe reads its width, height and duration, and ffmpeg grabs one frame as a JPEG,
// which the thumbnail Worker then resizes like any image. Each call is killed at a deadline the Worker sets before
// its own end, and none starts after it. Without ffmpeg on the host a video simply gets no thumbnail.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type VideoFrameResult = {
    data: Buffer;
    width: number;
    height: number;
    duration: number;
};

export async function extractVideoFrame(
    localPath: string,
    tmpDir: string,
    pathId: string,
    deadline: number,
): Promise<VideoFrameResult | null> {
    if (!(await isFfmpegAvailable())) return null;

    const probed = await probe(localPath, deadline);
    if (!probed) return null;

    const outPath = path.join(tmpDir, `${pathId}-video-frame.jpg`);
    try {
        let ok = await extractFrame(localPath, outPath, 1, deadline);
        if (!ok) ok = await extractFrame(localPath, outPath, 0, deadline);
        if (!ok) return null;

        const data = await fs.readFile(outPath);
        return { data, ...probed };
    } finally {
        try {
            await fs.unlink(outPath);
        } catch {}
    }
}

let cachedAvailable: boolean | null = null;

export async function isFfmpegAvailable(): Promise<boolean> {
    if (cachedAvailable !== null) return cachedAvailable;

    try {
        const proc = Bun.spawn(['ffmpeg', '-version'], { stdout: 'pipe', stderr: 'pipe' });
        await proc.exited;
        cachedAvailable = proc.exitCode === 0;
    } catch {
        cachedAvailable = false;
    }

    return cachedAvailable;
}

type ProbeResult = { width: number; height: number; duration: number };

async function probe(localPath: string, deadline: number): Promise<ProbeResult | null> {
    const run = await runBefore(deadline, [
        'ffprobe',
        '-v',
        'error',
        // A crafted playlist wearing video/mp4 could dereference file://http:// on some builds;
        // pin the input to local files (crypto covers encrypted local segments) before -i.
        '-protocol_whitelist',
        'file,crypto',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        localPath,
    ]);
    if (run?.exitCode !== 0) return null;
    try {
        const parsed = JSON.parse(run.stdout) as {
            streams?: { width?: number; height?: number }[];
            format?: { duration?: string };
        };
        const stream = parsed.streams?.[0];
        const durationStr = parsed.format?.duration;
        if (!stream?.width || !stream.height || !durationStr) return null;
        const duration = Number(durationStr);
        if (!Number.isFinite(duration) || duration <= 0) return null;
        return { width: stream.width, height: stream.height, duration };
    } catch {
        return null;
    }
}

async function extractFrame(
    localPath: string,
    outPath: string,
    seekSeconds: number,
    deadline: number,
): Promise<boolean> {
    const run = await runBefore(deadline, [
        'ffmpeg',
        // Same protocol pin as probe(): keep -i local, before the input.
        '-protocol_whitelist',
        'file,crypto',
        '-ss',
        String(seekSeconds),
        '-i',
        localPath,
        '-frames:v',
        '1',
        '-f',
        'image2',
        '-vcodec',
        'mjpeg',
        '-y',
        outPath,
    ]);
    if (run?.exitCode !== 0) return false;
    try {
        const stat = await fs.stat(outPath);
        return stat.size > 0;
    } catch {
        return false;
    }
}

// The call's timer lives in the Worker, which terminate() stops without stopping the child, so `deadline`, a
// Date.now() time, falls before the Worker's end. Null when it has passed: Bun reads a timeout of 0 as none.
async function runBefore(deadline: number, argv: string[]): Promise<{ exitCode: number; stdout: string } | null> {
    const left = deadline - Date.now();
    if (left <= 0) return null;
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore', timeout: left, killSignal: 'SIGKILL' });
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return { exitCode, stdout };
}
