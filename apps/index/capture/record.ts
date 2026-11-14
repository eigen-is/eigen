// Films a capture scene into the public site's About media. A video records the page's screencast frames with Chrome's
// own timestamps, as fast as the page repaints, and ffmpeg turns them into an AV1 and an H.264 mp4 at a steady 30 fps,
// with the first frame as a webp poster. A still is one screenshot as webp. Everything is made in a scratch folder and
// moves into the site only once every file of the scene is done, so a failed run leaves no half file there.

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import type { Scene } from './lib/scene';

type Frame = { file: string; time: number };

// The tool's scratch folder, which every run starts by wiping: the seeded data root, the logs, the frames.
export const CAPTURE_ROOT = '/tmp/eigen-capture';
type Codec = 'av1' | 'h264';

const MEDIA_DIR = join(import.meta.dir, '..', '..', 'apps', 'index', 'public', 'data', 'about', 'media');
const OUT_DIR = join(CAPTURE_ROOT, 'out');
const WEBP_QUALITY = '85';

// A screen recording barely changes from frame to frame, so one keyframe per loop (600 frames, 20 s) halves the
// files. At these settings AV1 comes out at about two thirds of H.264's size and still looks sharper.
const KEYFRAME_INTERVAL = '600';
const CODEC_ARGS: Record<Codec, string[]> = {
    av1: ['-c:v', 'libsvtav1', '-crf', '40', '-preset', '4', '-g', KEYFRAME_INTERVAL],
    h264: ['-c:v', 'libx264', '-crf', '23', '-preset', 'slow', '-g', KEYFRAME_INTERVAL, '-movflags', '+faststart'],
};

// The concat demuxer gives each file the duration under it, and needs the last file again to honor the last one.
export function concatList(frames: readonly Frame[], stopTime: number): string {
    const lines = ['ffconcat version 1.0'];
    for (const [i, frame] of frames.entries()) {
        const until = frames[i + 1]?.time ?? stopTime;
        lines.push(`file '${frame.file}'`, `duration ${(until - frame.time).toFixed(3)}`);
    }
    lines.push(`file '${frames[frames.length - 1].file}'`, '');
    return lines.join('\n');
}

export function encodeArgs(codec: Codec, listPath: string, outPath: string): string[] {
    return [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-vf',
        'fps=30,format=yuv420p',
        ...CODEC_ARGS[codec],
        outPath,
    ];
}

export async function recordVideo(page: Page, scene: Scene, run: () => Promise<void>): Promise<void> {
    const framesDir = join(CAPTURE_ROOT, 'frames', scene.name);
    rmSync(framesDir, { recursive: true, force: true });
    mkdirSync(framesDir, { recursive: true });
    mkdirSync(OUT_DIR, { recursive: true });

    const frames: Frame[] = [];
    const cdp = await page.context().newCDPSession(page);
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
        const file = join(framesDir, `${String(frames.length).padStart(5, '0')}.jpg`);
        writeFileSync(file, Buffer.from(data, 'base64'));
        frames.push({ file, time: metadata.timestamp ?? Date.now() / 1000 });
        cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 92,
        maxWidth: scene.viewport.width * 2,
        maxHeight: scene.viewport.height * 2,
        everyNthFrame: 1,
    });
    await run();
    const stopTime = Date.now() / 1000;
    await cdp.send('Page.stopScreencast');
    await cdp.detach();
    if (frames.length === 0) throw new Error(`${scene.name} recorded no frames`);

    const listPath = join(framesDir, 'list.txt');
    writeFileSync(listPath, concatList(frames, stopTime));
    const outputs = [`${scene.name}.av1.mp4`, `${scene.name}.h264.mp4`, `${scene.name}.webp`];
    await Promise.all([
        exec('ffmpeg', encodeArgs('av1', listPath, join(OUT_DIR, outputs[0]))),
        exec('ffmpeg', encodeArgs('h264', listPath, join(OUT_DIR, outputs[1]))),
        exec('cwebp', webpArgs(frames[0].file, join(OUT_DIR, outputs[2]))),
    ]);
    publish(outputs);
}

export async function takeStill(page: Page, scene: Scene): Promise<void> {
    mkdirSync(OUT_DIR, { recursive: true });
    const png = join(OUT_DIR, `${scene.name}.png`);
    await page.screenshot({ path: png });
    const output = `${scene.name}.webp`;
    await exec('cwebp', webpArgs(png, join(OUT_DIR, output)));
    publish([output]);
}

// This ffmpeg has no webp encoder, so the posters and stills go through libwebp's own cwebp.
const webpArgs = (input: string, output: string) => ['-quiet', '-q', WEBP_QUALITY, input, '-o', output];

async function exec(command: string, args: string[]): Promise<void> {
    const child = Bun.spawn([command, ...args], { stdout: 'ignore', stderr: 'pipe' });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`${command} exited with ${code}: ${stderr.trim()}`);
}

function publish(files: readonly string[]): void {
    mkdirSync(MEDIA_DIR, { recursive: true });
    for (const file of files) renameSync(join(OUT_DIR, file), join(MEDIA_DIR, file));
    console.log(`  ${files.join(', ')}`);
}
