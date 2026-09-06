import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type VideoFrameResult = {
    data: Buffer;
    width: number;
    height: number;
    duration: number;
};

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

const SUBPROC_TIMEOUT_MS = 20_000;

async function runWithTimeout(argv: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => proc.kill(), SUBPROC_TIMEOUT_MS);
    try {
        const [exitCode, stdout, stderr] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
    } finally {
        clearTimeout(timer);
    }
}

type ProbeResult = { width: number; height: number; duration: number };

async function probe(localPath: string): Promise<ProbeResult | null> {
    const { exitCode, stdout } = await runWithTimeout([
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
    if (exitCode !== 0) return null;
    try {
        const parsed = JSON.parse(stdout) as {
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

async function extractFrame(localPath: string, outPath: string, seekSeconds: number): Promise<boolean> {
    const { exitCode } = await runWithTimeout([
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
    if (exitCode !== 0) return false;
    try {
        const stat = await fs.stat(outPath);
        return stat.size > 0;
    } catch {
        return false;
    }
}

export async function extractVideoFrame(
    localPath: string,
    tmpDir: string,
    pathId: string,
): Promise<VideoFrameResult | null> {
    if (!(await isFfmpegAvailable())) return null;

    const probed = await probe(localPath);
    if (!probed) return null;

    const outPath = path.join(tmpDir, `${pathId}-video-frame.jpg`);
    try {
        let ok = await extractFrame(localPath, outPath, 1);
        if (!ok) ok = await extractFrame(localPath, outPath, 0);
        if (!ok) return null;

        const data = await fs.readFile(outPath);
        return { data, width: probed.width, height: probed.height, duration: probed.duration };
    } finally {
        try {
            await fs.unlink(outPath);
        } catch {}
    }
}
