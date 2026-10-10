import { afterAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { generateImagePreview } from '../../lib/shared/thumbnails';

const execFileAsync = promisify(execFile);
const TMP_DIR = path.join(os.tmpdir(), `eigen-thumbnail-worker-test-${Date.now()}`);

// exiftool-vendored ships the binary the worker's fallback shells out to.
const { exiftool } = await import('exiftool-vendored');
const EXIFTOOL_BIN = await exiftool.exiftoolPath();

// Every in-memory avatar conversion (contact photos, team logos) passes no tmpDir and the fixed pathId 'avatar'.
const AVATAR_OPTIONS = { maxSize: 512, quality: 80, fit: 'cover' } as const;

afterAll(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// A JPEG only exiftool can read: a real EXIF thumbnail in the given color plus a truncated scan, so sharp's
// own decode fails and the worker falls through to the exiftool fallback — its only path that needs a file
// on disk. The color makes each conversion's output traceable back to its own input.
async function thumbnailOnlyJpeg(name: string, background: { r: number; g: number; b: number }): Promise<Buffer> {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const thumbPath = path.join(TMP_DIR, `${name}-thumb.jpg`);
    const carrierPath = path.join(TMP_DIR, `${name}.jpg`);
    await sharp({ create: { width: 16, height: 16, channels: 3, background } })
        .jpeg()
        .toFile(thumbPath);
    await sharp({ create: { width: 64, height: 64, channels: 3, background } })
        .jpeg()
        .toFile(carrierPath);
    await execFileAsync(EXIFTOOL_BIN, ['-overwrite_original', `-ThumbnailImage<=${thumbPath}`, carrierPath]);

    const carrier = fs.readFileSync(carrierPath);
    return carrier.subarray(0, carrier.length - 30);
}

async function firstPixel(data: Buffer): Promise<{ r: number; g: number; b: number }> {
    const raw = await sharp(data).raw().toBuffer();
    return { r: raw[0]!, g: raw[1]!, b: raw[2]! };
}

describe('thumbnail worker scratch files', () => {
    test('concurrent tmpDir-less conversions keep their own bytes and write nothing to the CWD', async () => {
        const red = await thumbnailOnlyJpeg('red', { r: 220, g: 20, b: 20 });
        const blue = await thumbnailOnlyJpeg('blue', { r: 20, g: 20, b: 220 });
        // If sharp could decode these the conversions would never reach the fallback and prove nothing.
        await expect(sharp(red).metadata()).rejects.toThrow();
        await expect(sharp(blue).metadata()).rejects.toThrow();

        fs.writeFileSync(path.join(TMP_DIR, 'red.source'), red);
        fs.writeFileSync(path.join(TMP_DIR, 'blue.source'), blue);

        // A Worker reads TMPDIR from its process's start, and parallel test files convert in the shared one.
        const cwd = fs.mkdtempSync(path.join(TMP_DIR, 'cwd-'));
        const tmpdir = fs.mkdtempSync(path.join(TMP_DIR, 'tmp-'));
        const script = `
            const { generateImagePreview } = await import(process.env.THUMBNAILS);
            const convert = async (source, name) => {
                const bytes = Buffer.from(await Bun.file(source).arrayBuffer());
                const options = JSON.parse(process.env.OPTIONS);
                const result = await generateImagePreview(bytes, 'image/jpeg', name, '', 'avatar', options);
                return result && result.data.toString('base64');
            };
            const results = await Promise.all([convert(process.env.RED, 'red.jpg'), convert(process.env.BLUE, 'blue.jpg')]);
            console.log(JSON.stringify(results));
        `;
        const child = Bun.spawn([process.execPath, '-e', script], {
            cwd,
            env: {
                ...process.env,
                TMPDIR: tmpdir,
                THUMBNAILS: Bun.resolveSync('../../lib/shared/thumbnails', import.meta.dir),
                OPTIONS: JSON.stringify(AVATAR_OPTIONS),
                RED: path.join(TMP_DIR, 'red.source'),
                BLUE: path.join(TMP_DIR, 'blue.source'),
            },
        });
        const cwdSeen = new Set<string>();
        const poll = setInterval(() => {
            for (const name of fs.readdirSync(cwd)) cwdSeen.add(name);
        }, 2);
        const [redData, blueData]: (string | null)[] = JSON.parse(await new Response(child.stdout).text());
        clearInterval(poll);

        expect([...cwdSeen]).toEqual([]);
        // The dir each conversion scratches in instead is its own, and its finally removes it.
        expect(fs.readdirSync(tmpdir)).toEqual([]);
        expect(redData).not.toBeNull();
        expect(blueData).not.toBeNull();
        const redPixel = await firstPixel(Buffer.from(redData!, 'base64'));
        const bluePixel = await firstPixel(Buffer.from(blueData!, 'base64'));
        expect(redPixel.r).toBeGreaterThan(150);
        expect(redPixel.b).toBeLessThan(100);
        expect(bluePixel.b).toBeGreaterThan(150);
        expect(bluePixel.r).toBeLessThan(100);
    }, 30_000);

    test('a conversion with a tmpDir uses it and leaves nothing behind', async () => {
        const source = await thumbnailOnlyJpeg('green', { r: 20, g: 220, b: 20 });
        const tmpDir = path.join(TMP_DIR, 'mount-previews');

        const result = await generateImagePreview(source, 'image/jpeg', 'green.jpg', tmpDir, 'path-id', AVATAR_OPTIONS);

        expect(result).not.toBeNull();
        expect((await firstPixel(result!.data)).g).toBeGreaterThan(150);
        expect(fs.readdirSync(tmpDir)).toEqual([]);
    }, 30_000);
});
