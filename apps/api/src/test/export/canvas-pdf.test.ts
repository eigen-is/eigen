import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    baseDefaultsFor,
    DEFAULT_SCENE_META,
    ELEMENT_KINDS,
    SLIDE_SIZES,
    SLIDES_STYLE_DEFAULTS,
    type SlideSize,
    serializeBackgroundFill,
    solidFill,
    TRANSPARENT_COLOR,
    type VectorRectangleElement,
    type VectorRichTextElement,
    type VectorScene,
} from '@workspace/lib/vector';
import sharp from 'sharp';
import { exportDocument } from '../../lib/export/export-document';
import { isWeasyPrintAvailable } from '../../lib/export/weasyprint';
import { getHome } from '../../lib/home/get-home';
import { seedVectorDoc } from '../fixtures/golden-documents';
import { driveGet, drivePost, getTestContext } from '../setup';

// What a canvas PDF looks like, read off its pixels. WeasyPrint 68 loses two things a scaled or shifted
// page moves: it lays a page out ignoring transforms and cuts every line whose layout box passes the
// @page height, and it clips a translucent element to the page as the element's parent's transform
// maps it. At the old 0.5 a slide lost the later lines of a text box and every translucent element in
// its lower half; a drawing translated to its content lost its translucent elements.

// The PDF's first page at 72 dpi, one pixel per point: macOS's sips or poppler's pdftoppm.
const rasterizer = Bun.which('sips') ?? Bun.which('pdftoppm');

type Raster = { data: Buffer; width: number; height: number };

async function rasterize(pdf: Buffer): Promise<Raster> {
    const dir = await mkdtemp(join(tmpdir(), 'canvas-pdf-'));
    try {
        await Bun.write(join(dir, 'page.pdf'), pdf);
        const args = rasterizer?.endsWith('sips')
            ? ['-s', 'format', 'png', 'page.pdf', '--out', 'page.png']
            : ['-png', '-r', '72', '-singlefile', 'page.pdf', 'page'];
        const proc = Bun.spawn([rasterizer ?? '', ...args], { cwd: dir, stdout: 'ignore', stderr: 'ignore' });
        expect(await proc.exited).toBe(0);
        const { data, info } = await sharp(join(dir, 'page.png'))
            .flatten({ background: '#ffffff' })
            .raw()
            .toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

type Rgb = [number, number, number];

// The pixel at a point of the page, in points.
function pixelAt(page: Raster, x: number, y: number): Rgb {
    const i = (Math.round(y) * page.width + Math.round(x)) * 3;
    return [page.data[i], page.data[i + 1], page.data[i + 2]];
}

// The lowest row, in points, holding a pixel of the text's blue.
function lowestBlueRow(page: Raster): number {
    for (let y = page.height - 1; y >= 0; y--) {
        for (let x = 0; x < page.width; x++) {
            const [r, g, b] = pixelAt(page, x, y);
            if (r < 80 && g < 80 && b > 180) return y;
        }
    }
    return -1;
}

// Red at 50% over white is about (255, 128, 128): red stays, green and blue halve.
function expectHalfRed([r, g, b]: Rgb): void {
    expect(r).toBeGreaterThan(220);
    expect(g).toBeGreaterThan(90);
    expect(g).toBeLessThan(170);
    expect(b).toBeGreaterThan(90);
    expect(b).toBeLessThan(170);
}

function expectGreen([r, g, b]: Rgb): void {
    expect(r).toBeLessThan(120);
    expect(g).toBeGreaterThan(120);
    expect(b).toBeLessThan(120);
}

function rect(
    id: string,
    frameId: string,
    color: string,
    opacity: number,
    box: { x: number; y: number; width: number; height: number },
): VectorRectangleElement {
    return {
        ...baseDefaultsFor('rectangle', SLIDES_STYLE_DEFAULTS),
        ...ELEMENT_KINDS.rectangle.defaults(SLIDES_STYLE_DEFAULTS),
        id,
        type: 'rectangle',
        index: `a${id}`,
        frameId,
        ...box,
        angle: 0,
        seed: 1,
        fill: solidFill(color, 'solid'),
        strokeColor: TRANSPARENT_COLOR,
        opacity,
        corners: 'straight',
    };
}

// `lines` opaque blue lines of 48 px at a line height of 1.2, 57.6 px apart.
function textBox(
    frameId: string,
    box: { x: number; y: number; width: number; height: number },
    lines: number,
): VectorRichTextElement {
    return {
        ...baseDefaultsFor('richtext', SLIDES_STYLE_DEFAULTS),
        ...ELEMENT_KINDS.richtext.defaults(SLIDES_STYLE_DEFAULTS),
        id: '1',
        type: 'richtext',
        index: 'a1',
        frameId,
        ...box,
        angle: 0,
        seed: 1,
        html: Array.from({ length: lines }, (_, i) => `<p>Line ${i + 1}</p>`).join(''),
        fontSize: 48,
        lineHeight: 1.2,
        color: '#0000ff',
        strokeColor: TRANSPARENT_COLOR,
    };
}

// A W x H area at (x, y): twelve opaque blue lines from a quarter down, which run past half the
// height, an opaque green square and a translucent red one in the bottom quarter.
function area(frameId: string, x: number, y: number, height: number) {
    const text = textBox(frameId, { x: x + 100, y: y + height / 4, width: 900, height: (height * 3) / 4 - 40 }, 12);
    const green = { x: x + 1100, y: y + height - 260, width: 200, height: 200 };
    const red = { ...green, x: x + 1400 };
    return {
        elements: [text, rect('2', frameId, '#00aa00', 100, green), rect('3', frameId, '#ff0000', 50, red)],
        // Where each must print, in scene units from the area's top-left: the text box's top and
        // the squares' centres.
        textTop: height / 4,
        green: { x: 1200, y: height - 160 },
        red: { x: 1500, y: height - 160 },
    };
}

// CI installs WeasyPrint but no poppler, so this suite runs only where both a WeasyPrint and a
// rasterizer are on the machine, and skips everywhere else.
const suite = (await isWeasyPrintAvailable()) && rasterizer ? describe : describe.skip;

suite('canvas PDF — text, opaque and translucent elements print wherever they sit', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, 'default', 'root');
        rootId = root.id;
    });

    async function exportPdf(kind: 'slides' | 'vector', fileName: string, scene: VectorScene): Promise<Raster> {
        const created = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            'default',
            `folder/${rootId}/create/${kind}`,
            { fileName },
        );
        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument('default', created.id);
        seedVectorDoc(collab.doc, scene);
        const { mount, path } = await home.drive.resolveFile('default', created.id);
        return rasterize((await exportDocument(mount, path, 'pdf')).data);
    }

    // Every element of `placed` printed, its area `margin` scene pixels from the page's top-left on a
    // page at `scale` points per scene pixel. The text's lowest line lies more than half the area's
    // height into the box: past where the 0.5 layout cut it.
    function expectPrinted(
        page: Raster,
        placed: ReturnType<typeof area>,
        height: number,
        margin: number,
        scale: number,
    ): void {
        const at = ({ x, y }: { x: number; y: number }) => pixelAt(page, (x + margin) * scale, (y + margin) * scale);
        expect(lowestBlueRow(page) / scale - margin).toBeGreaterThan(placed.textTop + height / 2 + 60);
        expectGreen(at(placed.green));
        expectHalfRed(at(placed.red));
    }

    // A deck page is the deck's width whatever the slide size: a new deck's 720 pt, where a scene pixel is 0.375 pt, and
    // a PowerPoint widescreen deck's 960 pt, where it is 0.5.
    test.each([
        ['16:9', 720, 405],
        ['4:3', 720, 540],
        ['16:9', 960, 540],
    ] as const)(
        'a %s slide %s pt wide prints all of its lower half',
        async (slideSize: SlideSize, slideWidth, pageHeight) => {
            const { width, height } = SLIDE_SIZES[slideSize];
            const placed = area('f', 0, 0, height);
            const page = await exportPdf('slides', `lower-half-${slideSize.replace(':', 'x')}-${slideWidth}`, {
                elements: placed.elements,
                frames: [
                    {
                        id: 'f',
                        index: 'a0',
                        name: '',
                        width,
                        height,
                        background: serializeBackgroundFill({ type: 'solid', color: '#ffffff' }),
                    },
                ],
                meta: { ...DEFAULT_SCENE_META, slideSize, slideWidth },
            });
            expect([page.width, page.height]).toEqual([slideWidth, pageHeight]);
            expectPrinted(page, placed, height, 0, slideWidth / width);
        },
        120_000,
    );

    // A slide is the page whatever overhangs it: a text box from 600 above the slide runs 30 lines,
    // 1728 px, past its bottom, and the lines laid out more than a slide's height into the box print.
    test('a text box starting above a slide prints down to the slide bottom', async () => {
        const { width, height } = SLIDE_SIZES['16:9'];
        const page = await exportPdf('slides', 'above-the-slide', {
            elements: [textBox('f', { x: 100, y: -600, width: 900, height: 1700 }, 30)],
            frames: [
                {
                    id: 'f',
                    index: 'a0',
                    name: '',
                    width,
                    height,
                    background: serializeBackgroundFill({ type: 'solid', color: '#ffffff' }),
                },
            ],
            meta: { ...DEFAULT_SCENE_META, slideSize: '16:9' },
        });
        // Within a line and a half of the bottom edge, at a new deck's 0.5 pt per scene pixel.
        expect(lowestBlueRow(page)).toBeGreaterThan(page.height - 1.5 * 57.6 * 0.5);
    }, 120_000);

    // A drawing's page starts at its content, wherever that is: far from the scene origin, far above and
    // left of it, and across it. It prints at 1 px = 0.75 pt.
    test.each([
        ['far from the origin', 2000, 3000, 1080, 825],
        ['above and left of the origin', -4000, -3000, 1080, 825],
        ['across the origin', -960, -500, 1000, 765],
    ] as const)(
        'a drawing %s prints all of its lower half',
        async (_where, x, y, height, pageHeight) => {
            const width = 1920;
            const placed = area('', x, y, height);
            // Two corner marks make the page the area plus the 10 px margin.
            const corners = [
                rect('8', '', '#000000', 100, { x, y, width: 20, height: 20 }),
                rect('9', '', '#000000', 100, { x: x + width - 20, y: y + height - 20, width: 20, height: 20 }),
            ];
            const page = await exportPdf('vector', `drawing-${x}-${y}`, {
                elements: [...placed.elements, ...corners],
                frames: [],
                meta: DEFAULT_SCENE_META,
            });
            expect([page.width, page.height]).toEqual([1455, pageHeight]);
            expectPrinted(page, placed, height, 10, 0.75);
        },
        120_000,
    );
});
