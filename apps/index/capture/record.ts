// Films a capture scene into the public site's About media. A video records a page's screencast frames with Chrome's
// own timestamps, as fast as the page repaints, and ffmpeg turns them into an AV1 and an H.264 mp4 at a steady 30 fps,
// with the first frame as a webp poster. A scene of two people can film both pages at once, joined side by side. A
// still is one screenshot as webp. Everything is made in a scratch folder and moves into the site only once every
// file of the scene is done, so a failed run leaves no half file there.

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import type { Frame, Output } from './lib/ffmpeg';
import { concatList, encodeArgs, startingAt } from './lib/ffmpeg';
import type { Scene } from './lib/scene';

// The tool's scratch folder, which every run starts by wiping: the seeded data root, the logs, the frames.
export const CAPTURE_ROOT = '/tmp/eigen-capture';

const MEDIA_DIR = join(import.meta.dir, '..', 'public', 'data', 'about', 'media');
const OUT_DIR = join(CAPTURE_ROOT, 'out');
const WEBP_QUALITY = '85';

// A quiet grey seam, so two pages in one theme don't run into each other.
const GAP_COLOR: Record<Scene['theme'], string> = { light: '#d4d4d4', dark: '#3a3a3a' };
const GAP = 24;

// The first page, or every page side by side when the scene asks for it.
export async function recordVideo(pages: readonly Page[], scene: Scene, run: () => Promise<void>): Promise<void> {
    const sceneDir = join(CAPTURE_ROOT, 'frames', scene.name);
    rmSync(sceneDir, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });

    const filmed = scene.composite === 'side-by-side' ? pages : pages.slice(0, 1);
    const recordings = await Promise.all(
        filmed.map((page, i) => startScreencast(page, scene, join(sceneDir, String(i)))),
    );
    await run();
    const stopTime = Date.now() / 1000;
    const takes = await Promise.all(recordings.map((stop) => stop()));
    if (takes.some((frames) => frames.length === 0)) throw new Error(`${scene.name} recorded no frames`);

    const start = Math.max(...takes.map((frames) => frames[0].time));
    const listPaths = takes.map((frames, i) => {
        const listPath = join(sceneDir, `${i}.txt`);
        writeFileSync(listPath, concatList(startingAt(frames, start), stopTime));
        return listPath;
    });
    const layout = { height: scene.viewport.height * 2, gap: GAP, color: GAP_COLOR[scene.theme] };
    const encode = (output: Output, file: string) => exec('ffmpeg', encodeArgs(output, listPaths, layout, file));
    const outputs = [`${scene.name}.av1.mp4`, `${scene.name}.h264.mp4`, `${scene.name}.webp`];
    const posterPng = join(sceneDir, 'poster.png');
    await Promise.all([
        encode('av1', join(OUT_DIR, outputs[0])),
        encode('h264', join(OUT_DIR, outputs[1])),
        encode('poster', posterPng).then(() => exec('cwebp', webpArgs(posterPng, join(OUT_DIR, outputs[2])))),
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

// Writes the page's screencast frames into framesDir as they come, until the returned stop is called, which gives them
// with Chrome's own timestamps.
async function startScreencast(page: Page, scene: Scene, framesDir: string): Promise<() => Promise<Frame[]>> {
    mkdirSync(framesDir, { recursive: true });
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
    return async () => {
        await cdp.send('Page.stopScreencast');
        await cdp.detach();
        return frames;
    };
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
