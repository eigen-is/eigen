import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { sharpResize } from '../../lib/shared/sharp-resize';
import type { WorkerInput } from '../../lib/shared/thumbnail-worker';
import { cpuClock } from '../cpu-time';

const TMP_DIR = join(tmpdir(), `eigen-sharp-resize-test-${Date.now()}`);

// What the export asks for: a JPEG, at most 2560 px.
const AS_JPEG: WorkerInput['options'] = { maxSize: 2560, quality: 90, fit: 'inside', format: 'jpeg' };

// An RGBA picture of 64 by 64, opaque but for the alpha `alphaAt` gives a pixel.
function rgba(alphaAt: (index: number) => number = () => 255) {
    const pixels = Buffer.alloc(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; i++) pixels.set([i % 256, (i * 7) % 256, (i * 13) % 256, alphaAt(i)], i * 4);
    return sharp(pixels, { raw: { width: 64, height: 64, channels: 4 } });
}

// An 8 by 8 palette PNG of two colours whose tRNS chunk gives them the alphas `alphas`: sharp writes no such file.
function palettePng(alphas: [number, number]): Buffer {
    const chunk = (type: string, body: Buffer) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(body.length);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(Bun.hash.crc32(Buffer.concat([Buffer.from(type), body])));
        return Buffer.concat([length, Buffer.from(type), body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(8, 0);
    header.writeUInt32BE(8, 4);
    header.set([8, 3], 8);
    // Each row is a filter byte and eight indices, the two colours in a checkerboard.
    const rows = Buffer.alloc(8 * 9);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) rows[y * 9 + 1 + x] = (x + y) % 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('PLTE', Buffer.from([255, 0, 0, 0, 0, 255])),
        chunk('tRNS', Buffer.from(alphas)),
        chunk('IDAT', deflateSync(rows)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

async function seeThrough(source: Buffer): Promise<boolean | undefined> {
    return (await sharpResize(source, AS_JPEG))?.hasAlpha;
}

describe('sharpResize to JPEG reports whether the picture it sends shows through', () => {
    test('a soft-edged logo does, and one pixel at alpha 254 does', async () => {
        const logo =
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><circle cx="100" cy="100" r="80" fill="#2563eb"/></svg>';
        expect(await seeThrough(await sharp(Buffer.from(logo)).png().toBuffer())).toBe(true);
        expect(
            await seeThrough(
                await rgba((i) => (i === 2080 ? 254 : 255))
                    .png()
                    .toBuffer(),
            ),
        ).toBe(true);
    });

    test('a screenshot whose alpha channel is opaque throughout does not', async () => {
        expect(await seeThrough(await rgba().png().toBuffer())).toBe(false);
    });

    test('a palette PNG with tRNS does only where an entry is see-through', async () => {
        expect(await seeThrough(palettePng([255, 255]))).toBe(false);
        expect(await seeThrough(palettePng([255, 0]))).toBe(true);
    });

    test('a 16-bit RGBA does only where its alpha is', async () => {
        expect(await seeThrough(await rgba().toColourspace('rgb16').png().toBuffer())).toBe(false);
        expect(
            await seeThrough(
                await rgba((i) => i % 256)
                    .toColourspace('rgb16')
                    .png()
                    .toBuffer(),
            ),
        ).toBe(true);
    });

    test('a GIF does only where a pixel is transparent', async () => {
        expect(await seeThrough(await rgba().gif().toBuffer())).toBe(false);
        expect(
            await seeThrough(
                await rgba((i) => (i < 64 ? 0 : 255))
                    .gif()
                    .toBuffer(),
            ),
        ).toBe(true);
    });

    test("a PNG target reports the source's alpha channel", async () => {
        const result = await sharpResize(await rgba().png().toBuffer(), { ...AS_JPEG, format: 'png' });
        expect(result?.hasAlpha).toBe(true);
    });
});

describe('sharpResize of a large source', () => {
    const source = join(TMP_DIR, 'large.png');

    beforeAll(async () => {
        mkdirSync(TMP_DIR, { recursive: true });
        await rgba().resize(8000, 8000, { kernel: 'nearest' }).png().toFile(source);
    });

    afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

    // Asking the source whether it is opaque decoded all 64 Mpx of it a second time, which cost the JPEG eight times
    // the CPU of its resize. Sharp decodes in native code, where a test cannot count the decodes, so the test weighs
    // the CPU each one spends beside the plain resize. CPU time, unlike the clock, does not grow when other processes
    // keep the machine busy. The two take turns and each keeps its cheapest run, so a pause that slows one fails nothing.
    test('decodes the source once to test the alpha of the 2560 px picture', async () => {
        const cpuOf = async (run: () => Promise<unknown>) => {
            const cpuMs = cpuClock();
            await run();
            return cpuMs();
        };
        let [resize, resized] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
        for (let run = 0; run < 3; run++) {
            resize = Math.min(
                resize,
                await cpuOf(() => sharp(source).resize(2560, 2560, { fit: 'inside' }).jpeg({ quality: 90 }).toBuffer()),
            );
            resized = Math.min(resized, await cpuOf(() => sharpResize(source, AS_JPEG)));
        }
        const result = await sharpResize(source, AS_JPEG);
        expect(result?.hasAlpha).toBe(false);
        expect(resized).toBeLessThan(resize * 1.6);
    }, 30_000);
});

// A Drive thumbnail is a still, so a grid of GIFs doesn't play; every other WebP, such as the screen preview or an
// avatar, keeps the animation.
describe('sharpResize of an animated source', () => {
    const AS_WEBP: WorkerInput['options'] = { maxSize: 512, quality: 80, fit: 'inside', format: 'webp' };

    async function twoFrameGif(): Promise<Buffer> {
        const frame = (red: number) =>
            sharp({ create: { width: 8, height: 8, channels: 3, background: { r: red, g: 0, b: 0 } } })
                .png()
                .toBuffer();
        return sharp([await frame(255), await frame(0)], { join: { animated: true } })
            .gif()
            .toBuffer();
    }

    async function framesOf(options: WorkerInput['options']): Promise<number | undefined> {
        const result = await sharpResize(await twoFrameGif(), options);
        if (!result) throw new Error('sharpResize gave no picture');
        return (await sharp(result.data).metadata()).pages;
    }

    test('keeps every frame in a WebP', async () => {
        expect(await framesOf(AS_WEBP)).toBe(2);
    });

    test('keeps the first frame only when asked for a still', async () => {
        expect(await framesOf({ ...AS_WEBP, still: true })).toBeUndefined();
    });
});
