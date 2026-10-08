import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../../lib/core';
import { type ExportMedia, transferListOf } from '../../lib/document/transform/protocol';
import { collectExportMedia } from '../../lib/export/media';
import { Mount } from '../../lib/mount/mount';
import { SVG_INLINE_MAX_BYTES } from '../../lib/preview/svg-media-inline';
import * as thumbnails from '../../lib/shared/thumbnails';
import { createTestMountConfig } from '../mount-test-helpers';

const dir = join(import.meta.dir, `../../../../../data-test/test-export-media-${Date.now()}`);

function createGetLocalDatabase(baseDir: string) {
    return async <S extends SchemaType>(
        config: DatabaseConfig<S>,
        relativePath: string,
    ): Promise<ManagedDatabase<S>> => {
        const db = new ManagedDatabase(config, join(baseDir, relativePath));
        await db.open(0);
        return db;
    };
}

// Fully transparent, so a JPEG's black would show in the first pixel.
const clear = () =>
    sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } });

// A gradient, so a lossy step would show in the pixels.
function gradient(width: number, height: number): Sharp {
    const pixels = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) pixels.set([i % 256, (i * 7) % 256, (i * 13) % 256], i * 3);
    return sharp(pixels, { raw: { width, height, channels: 3 } });
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><rect width="300" height="150" fill="#2563eb"/><text x="10" y="80">a&#160;b</text><image href="https://example.com/beacon.png"/></svg>`;

const PNG_SIGNATURE = '89504e47';
const JPEG_SIGNATURE = 'ffd8ff';

function signatureOf(data: ArrayBuffer): string {
    return Buffer.from(data).subarray(0, 4).toString('hex');
}

function find(media: ExportMedia[], name: string): ExportMedia {
    const item = media.find((candidate) => candidate.name === name);
    if (!item) throw new Error(`no ${name}`);
    return item;
}

describe('collectExportMedia', () => {
    let mount: Mount;
    let containerId: string;
    let sources: Map<string, Buffer>;

    beforeAll(async () => {
        mkdirSync(dir, { recursive: true });
        mount = new Mount(
            'test-owner-id',
            dir,
            createTestMountConfig('test-export-media'),
            createGetLocalDatabase(dir),
        );
        await mount.init();
        const root = await mount.getRootFolder();
        if (!root) throw new Error('no root folder');
        containerId = await mount.createFolder(root.id, 'doc.eigendoc');
        const mediaId = await mount.createFolder(containerId, 'media');
        sources = new Map([
            ['chart.png', await gradient(800, 500).png().toBuffer()],
            ['wide.png', await gradient(3000, 1000).png().toBuffer()],
            ['still.gif', await gradient(60, 40).gif().toBuffer()],
            [
                'photo.jpg',
                await gradient(600, 400)
                    .jpeg()
                    .withExif({
                        IFD0: { Copyright: 'Eigen' },
                        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 5/1 0/1' },
                    })
                    .toBuffer(),
            ],
            ['lossless.webp', await gradient(320, 200).webp({ lossless: true }).toBuffer()],
            ['lossy.webp', await gradient(320, 200).webp({ quality: 80 }).toBuffer()],
            ['drawing.svg', Buffer.from(SVG)],
            // Past the inliner's cap, which binds only what it builds: nothing here is inlined.
            [
                'huge.svg',
                Buffer.from(
                    `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${' '.repeat(SVG_INLINE_MAX_BYTES)}</svg>`,
                ),
            ],
            // HTML's &nbsp; in an SVG file: no XML reader draws it, and only the transform Worker's pass rewrites it.
            [
                'html.svg',
                Buffer.from(
                    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>a&nbsp;b</text></svg>',
                ),
            ],
            // VP8X: a lossy WebP with alpha.
            ['clear.webp', await clear().webp({ quality: 80 }).toBuffer()],
            ['clear.tiff', await clear().tiff({ compression: 'lzw' }).toBuffer()],
            // A PNG whose stored type says JPEG.
            ['clear.jpg', await clear().png().toBuffer()],
            ['broken.png', Buffer.from('not a png')],
            // A PDF wearing an Illustrator name, which the thumbnail Worker would read through exiftool.
            ['art.ai', await gradient(40, 40).png().toBuffer()],
            // A real video, from which the thumbnail Worker would take a frame.
            [
                'clip.mp4',
                Buffer.from(await Bun.file(join(import.meta.dir, '../fixtures/tiny-video.mp4')).arrayBuffer()),
            ],
        ]);
        const mimes: Record<string, string> = {
            png: 'image/png',
            gif: 'image/gif',
            jpg: 'image/jpeg',
            webp: 'image/webp',
            tiff: 'image/tiff',
            svg: 'image/svg+xml',
            mp4: 'video/mp4',
            ai: 'application/pdf',
        };
        for (const [name, bytes] of sources) {
            const mime = mimes[name.split('.').pop() ?? ''] ?? '';
            await mount.createFile(mediaId, name, mime, bytes.length, bytes);
        }
    });

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    async function collect(format: 'docx' | 'html' | 'pdf-html', signal?: AbortSignal): Promise<ExportMedia[]> {
        const container = await mount.getPath(containerId);
        if (!container) throw new Error('no container');
        return collectExportMedia(mount, container, format, signal);
    }

    // A docx re-encodes every image from its source on the thumbnail semaphore every upload and preview shares.
    test('a docx prepares one media item at a time', async () => {
        const encode = thumbnails.generateImagePreview;
        let active = 0;
        let peak = 0;
        const spy = spyOn(thumbnails, 'generateImagePreview').mockImplementation(async (...args) => {
            peak = Math.max(peak, ++active);
            try {
                return await encode(...args);
            } finally {
                active--;
            }
        });
        try {
            await collect('docx');
        } finally {
            spy.mockRestore();
        }
        expect(peak).toBe(1);
    }, 60_000);

    test('a docx queues no more media once its export aborts', async () => {
        const controller = new AbortController();
        const spy = spyOn(thumbnails, 'generateImagePreview').mockImplementation(async () => {
            controller.abort();
            return null;
        });
        let calls = 0;
        try {
            await collect('docx', controller.signal);
            calls = spy.mock.calls.length;
        } finally {
            spy.mockRestore();
        }
        expect(calls).toBe(1);
    }, 60_000);

    test('a docx takes a PNG of a lossless source and a JPEG of a photo, with the Worker size', async () => {
        const media = await collect('docx');
        const kinds = (name: string) => {
            const { contentType, data, width, height } = find(media, name);
            return [contentType, signatureOf(data).slice(0, contentType === 'image/png' ? 8 : 6), width, height];
        };
        expect(kinds('chart.png')).toEqual(['image/png', PNG_SIGNATURE, 800, 500]);
        expect(kinds('still.gif')).toEqual(['image/png', PNG_SIGNATURE, 60, 40]);
        expect(kinds('lossless.webp')).toEqual(['image/png', PNG_SIGNATURE, 320, 200]);
        expect(kinds('photo.jpg')).toEqual(['image/jpeg', JPEG_SIGNATURE, 600, 400]);
        expect(kinds('lossy.webp')).toEqual(['image/jpeg', JPEG_SIGNATURE, 320, 200]);
        for (const item of media) expect(item.png === undefined).toBe(item.contentType !== 'image/svg+xml');
    }, 60_000);

    test('the WebP sources are what the format rule reads: VP8L lossless, VP8 lossy, VP8X with alpha', () => {
        const chunk = (name: string) => sources.get(name)?.toString('latin1', 12, 16);
        expect([chunk('lossless.webp'), chunk('lossy.webp'), chunk('clear.webp')]).toEqual(['VP8L', 'VP8 ', 'VP8X']);
    });

    test('a transparent image stays a transparent PNG, whatever its type or stored MIME says', async () => {
        const media = await collect('docx');
        for (const name of ['clear.webp', 'clear.tiff', 'clear.jpg']) {
            const { contentType, data, width, height } = find(media, name);
            const alpha = (await sharp(Buffer.from(data)).ensureAlpha().raw().toBuffer())[3];
            expect([name, contentType, signatureOf(data), width, height, alpha]).toEqual([
                name,
                'image/png',
                PNG_SIGNATURE,
                64,
                32,
                0,
            ]);
        }
    }, 60_000);

    test('a PNG comes from the source, pixel for pixel, never the lossy preview', async () => {
        const chart = find(await collect('docx'), 'chart.png');
        const raw = (bytes: Buffer) => sharp(bytes).removeAlpha().raw().toBuffer();
        const source = sources.get('chart.png');
        if (!source) throw new Error('no source');
        expect((await raw(Buffer.from(chart.data))).equals(await raw(source))).toBe(true);
    }, 60_000);

    test('a source past 2560 px shrinks to it, its ratio kept, and reports its own size', async () => {
        const wide = find(await collect('docx'), 'wide.png');
        const { width, height } = await sharp(Buffer.from(wide.data)).metadata();
        expect([width, height]).toEqual([2560, 853]);
        expect([wide.width, wide.height]).toEqual([3000, 1000]);
    }, 60_000);

    test("a photo's EXIF, its GPS included, does not reach the docx", async () => {
        const source = sources.get('photo.jpg');
        if (!source) throw new Error('no source');
        expect((await sharp(source).metadata()).exif).toBeDefined();
        const photo = find(await collect('docx'), 'photo.jpg');
        expect((await sharp(Buffer.from(photo.data)).metadata()).exif).toBeUndefined();
        expect(Buffer.from(photo.data).includes('Eigen')).toBe(false);
    }, 60_000);

    test('an SVG is its own bytes, which the transform Worker sanitizes, beside a PNG at its own size', async () => {
        const svg = find(await collect('docx'), 'drawing.svg');
        expect([svg.contentType, svg.width, svg.height]).toEqual(['image/svg+xml', 300, 150]);
        expect(Buffer.from(svg.data).toString('utf8')).toBe(SVG);
        const png = svg.png ?? new ArrayBuffer(0);
        expect(signatureOf(png)).toBe(PNG_SIGNATURE);
        const { width, height } = await sharp(Buffer.from(png)).metadata();
        expect([width, height]).toEqual([300, 150]);
    }, 60_000);

    test('media no reader can draw is dropped', async () => {
        const names = (await collect('docx')).map((item) => item.name);
        expect(names).not.toContain('broken.png');
        expect(names).not.toContain('clip.mp4');
        // Its PNG is drawn from the file's own bytes.
        expect(names).not.toContain('html.svg');
    }, 60_000);

    test.each(['docx', 'html'] as const)(
        '%s hands no SVG past SVG_INLINE_MAX_BYTES to the Worker',
        async (format) => {
            expect((await collect(format)).map((item) => item.name)).not.toContain('huge.svg');
        },
        60_000,
    );

    test("a docx shows only what the screen preview shows: a PDF's media stays out, whatever its name", async () => {
        const names = (await collect('docx')).map((item) => item.name);
        expect(names).not.toContain('art.ai');
    }, 60_000);

    test.each(['html', 'pdf-html'] as const)(
        '%s keeps the screen preview: WebP rasters, the SVG as its own bytes, no size and no PNG',
        async (format) => {
            const media = await collect(format);
            expect(media.map((item) => [item.name, item.contentType]).sort()).toEqual(
                [
                    ['chart.png', 'image/webp'],
                    ['clear.jpg', 'image/webp'],
                    ['clear.tiff', 'image/webp'],
                    ['clear.webp', 'image/webp'],
                    ['drawing.svg', 'image/svg+xml'],
                    ['html.svg', 'image/svg+xml'],
                    ['lossless.webp', 'image/webp'],
                    ['lossy.webp', 'image/webp'],
                    ['photo.jpg', 'image/webp'],
                    ['still.gif', 'image/webp'],
                    ['wide.png', 'image/webp'],
                ].sort(),
            );
            for (const item of media) {
                expect([item.width, item.height, item.png]).toEqual([undefined, undefined, undefined]);
            }
            expect(Buffer.from(find(media, 'drawing.svg').data).toString('utf8')).toBe(SVG);
        },
        60_000,
    );

    test("an SVG's PNG rides the transfer list with its bytes", async () => {
        const media = await collect('docx');
        const svg = find(media, 'drawing.svg');
        const transfer = transferListOf({
            kind: 'export',
            documentType: 'eigendoc',
            format: 'docx',
            title: 'doc.eigendoc',
            media,
            publicOrigin: undefined,
            source: { snapshot: null, updates: [] },
        });
        if (!svg.png) throw new Error('no fallback');
        expect(transfer).toContain(svg.data);
        expect(transfer).toContain(svg.png);
        expect(transfer).toHaveLength(media.length + 1);
    }, 60_000);
});
