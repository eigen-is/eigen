// Audits the pptx writer on a corpus. roundtrip is its gate (office-audit.ts): each file the reader imports becomes a
// deck as an import makes one, is written by the writer (`--writer`, writePptx's signature) with its pictures prepared
// as an export prepares them, and imported again; the two decks are compared slide by slide and element by element in
// z-order, each length in the EMU the writer writes it in, a picture by its type and pixel size.
//
// Usage:
//   bun apps/api/src/scripts/pptx-audit.ts roundtrip <corpus dir...> --out <dir> [--writer <module>] [--dump <dir>] [--timeout <s>] [--max-rss <MB>]
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gradientStops } from '@workspace/lib/background';
import type { VectorElement, VectorFrame, VectorScene } from '@workspace/lib/vector';
import { elementsInFrame, normalizeAngle, parsePoints, pointsBounds, slidePxToPt } from '@workspace/lib/vector';
import type { TransformWarning } from '../lib/document/transform/protocol';
import { lossCounter } from '../lib/document/transform/protocol';
import type { writePptx } from '../lib/export/slides/pptx/to-pptx';
import type { ImportedMedia } from '../lib/import/image-types';
import { EMU_PER_POINT } from '../lib/ooxml/ooxml';
import type {
    DifferenceGroup,
    Listed,
    RoundtripDifference,
    RoundtripGate,
    RoundtripMeta,
    RoundtripOptions,
} from './office-audit';
import {
    canonical,
    chartFields,
    chartsNotImported,
    classify,
    lossCounts,
    officeMedia,
    roundtripChild,
    roundtripLine,
    runRoundtrip as runGate,
} from './office-audit';

// A picture as the deck shows it: its type and its size in pixels, none for one sharp can't read.
type Picture = { contentType: string; width?: number; height?: number };

type Deck = { scene: VectorScene; media: ImportedMedia[]; pictures: ReadonlyMap<string, Picture> };

// The two decks, and the media the export was handed, by the first import's name.
export type PptxRoundtripContext = { a: Deck; b: Deck; prepared: ReadonlyMap<string, Picture> };

// Fields no file carries: an element's identity, its place in the z-order and on its slide, which the comparison
// takes from the order itself, and the roughjs seed an import draws afresh.
const UNCOMPARED = new Set(['id', 'index', 'frameId', 'seed', 'commentCardIds']);

// The writer's units (export/slides/pptx/): lengths in EMU at the deck's scale, text sizes in 100ths of a point, angles in
// 60,000ths of a degree, shares in 1000ths of a percent.
const LENGTHS = new Set(['x', 'y', 'width', 'height', 'strokeWidth', 'seriesStrokeWidth', 'padding']);
const TEXT_SIZES = new Set(['fontSize', 'letterSpacing']);
const ANGLES = new Set(['angle', 'startAngle', 'sweepAngle']);

type Units = { emu: (px: number) => number; centipoints: (px: number) => number };

function unitsOf(scene: VectorScene): Units {
    const scale = slidePxToPt(1, scene.meta.slideWidth) * EMU_PER_POINT;
    return {
        emu: (px) => Math.round(px * scale),
        centipoints: (px) => Math.round(slidePxToPt(px, scene.meta.slideWidth) * 100),
    };
}

// A field as the writer writes it, so a value that comes back to the unit is the same value.
function written(
    element: VectorElement,
    field: string,
    value: unknown,
    units: Units,
    pictures: ReadonlyMap<string, Picture>,
    order: ReadonlyMap<string, number>,
): unknown {
    if (typeof value === 'number') {
        if (LENGTHS.has(field)) return units.emu(value);
        if (TEXT_SIZES.has(field)) return units.centipoints(value);
        if (ANGLES.has(field)) return Math.round(normalizeAngle(value) * 60_000) % 21_600_000;
        if (field === 'opacity') return Math.round(value * 1000);
        if (field === 'lineHeight' && 'fontSize' in element) return units.centipoints(value * element.fontSize);
        return value;
    }
    if (typeof value !== 'string') return value;
    if (field === 'mediaName') return pictures.get(value) ?? null;
    if (field === 'points') {
        const points: unknown = JSON.parse(value || '[]');
        return Array.isArray(points)
            ? points.map((point) => (Array.isArray(point) ? point.map(units.emu) : point))
            : points;
    }
    // A path's unit box drawn at the element's size.
    if (field === 'path' && 'width' in element) {
        let axis = 0;
        return value.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, (number) =>
            String(units.emu(Number(number) * (axis++ % 2 === 0 ? element.width : element.height))),
        );
    }
    if (field === 'fill' || field === 'fixedSegments') return value && JSON.parse(value);
    // A binding names its element by its place in the z-order.
    if ((field === 'startBinding' || field === 'endBinding') && value) {
        const binding: unknown = JSON.parse(value);
        return typeof binding === 'object' && binding !== null && 'elementId' in binding
            ? { ...binding, elementId: order.get(String(binding.elementId)) ?? null }
            : binding;
    }
    return value;
}

const elementText = (element: VectorElement) =>
    'html' in element ? element.html.replace(/<[^>]*>/g, '') : 'text' in element ? element.text : '';

// A path's points round twice, to the EMU the writer writes and over the path's rounded width the reader divides by, so
// two paths of the same commands whose numbers are within an EMU are the same path.
function withinAnEmu(a: unknown, b: unknown): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const [x, y] = [a.split(' '), b.split(' ')];
    return (
        x.length === y.length && x.every((token, i) => token === y[i] || Math.abs(Number(token) - Number(y[i])) <= 1)
    );
}

// Past this many pairs a slide's elements pair by position.
const MAX_ALIGNED = 4_000_000;

type Step = [number, number] | { x: VectorElement[]; y: VectorElement[]; at: number };

// The elements paired as the longest run of the same kind and text in z-order; between two pairs, a stretch as long on
// both sides pairs by position, and one that isn't is a single difference of elements.
function align(a: VectorElement[], b: VectorElement[]): Step[] {
    const key = (element: VectorElement) => `${element.type}\n${elementText(element)}`;
    const [keysA, keysB] = [a.map(key), b.map(key)];
    const [n, m] = [a.length, b.length];
    const pairs: [number, number][] = [];
    if (n * m <= MAX_ALIGNED) {
        const longest = new Uint32Array((n + 1) * (m + 1));
        for (let i = n - 1; i >= 0; i--)
            for (let j = m - 1; j >= 0; j--)
                longest[i * (m + 1) + j] =
                    keysA[i] === keysB[j]
                        ? longest[(i + 1) * (m + 1) + j + 1] + 1
                        : Math.max(longest[(i + 1) * (m + 1) + j], longest[i * (m + 1) + j + 1]);
        for (let i = 0, j = 0; i < n && j < m; ) {
            if (keysA[i] === keysB[j]) pairs.push([i++, j++]);
            else if (longest[(i + 1) * (m + 1) + j] >= longest[i * (m + 1) + j + 1]) i++;
            else j++;
        }
    }
    const steps: Step[] = [];
    let [i, j] = [0, 0];
    for (const [pi, pj] of [...pairs, [n, m]]) {
        const [x, y] = [a.slice(i, pi), b.slice(j, pj)];
        if (x.length === y.length) for (let k = 0; k < x.length; k++) steps.push([i + k, j + k]);
        else steps.push({ x, y, at: i });
        if (pi < n) steps.push([pi, pj]);
        [i, j] = [pi + 1, pj + 1];
    }
    return steps;
}

const fields = (value: object) => new Map<string, unknown>(Object.entries(value));

// The deck's page, then slide by slide: its name, size and background, and its elements in z-order, field by field in
// the writer's units. An element of another kind is a difference of the two elements.
export function diffDecks(a: Deck, b: Deck): RoundtripDifference[] {
    const differences: RoundtripDifference[] = [];
    const note = (feature: string, at: string, x: unknown, y: unknown) => {
        if (canonical(x) !== canonical(y)) differences.push({ feature, at, a: x, b: y });
    };
    const units = unitsOf(a.scene);
    note('slide size', '', a.scene.meta.slideSize, b.scene.meta.slideSize);
    const slideWidth = (deck: Deck) => Math.round(deck.scene.meta.slideWidth * EMU_PER_POINT);
    note('slide width', '', slideWidth(a), slideWidth(b));
    note('slides', '', a.scene.frames.length, b.scene.frames.length);
    const background = (frame: VectorFrame, deck: Deck) => {
        const parsed: unknown = frame.background ? JSON.parse(frame.background) : null;
        return typeof parsed === 'object' && parsed !== null && 'mediaName' in parsed
            ? { ...parsed, mediaName: deck.pictures.get(String(parsed.mediaName)) ?? null }
            : parsed;
    };
    for (const [index, frameA] of a.scene.frames.entries()) {
        const frameB = b.scene.frames[index];
        if (!frameB) continue;
        const at = `slide ${index + 1}`;
        note('slide name', at, frameA.name, frameB.name);
        note('slide background', at, background(frameA, a), background(frameB, b));
        const [elementsA, elementsB] = [
            elementsInFrame(a.scene.elements, frameA.id),
            elementsInFrame(b.scene.elements, frameB.id),
        ];
        const orderOf = (elements: VectorElement[]) => new Map(elements.map((element, i) => [element.id, i]));
        const [orderA, orderB] = [orderOf(elementsA), orderOf(elementsB)];
        for (const step of align(elementsA, elementsB)) {
            if (!Array.isArray(step)) {
                differences.push({ feature: 'elements', at: `${at} #${step.at}`, a: step.x, b: step.y });
                continue;
            }
            const [x, y] = [elementsA[step[0]], elementsB[step[1]]];
            const place = `${at} #${step[0]}`;
            if (x.type !== y.type) {
                differences.push({ feature: 'element', at: place, a: x, b: y });
                continue;
            }
            const [left, right] = [x, y].map((element) =>
                fields(element.type === 'chart' ? chartFields(element) : element),
            );
            for (const field of new Set([...left.keys(), ...right.keys()])) {
                if (UNCOMPARED.has(field)) continue;
                const valueA = written(x, field, left.get(field), units, a.pictures, orderA);
                const valueB = written(y, field, right.get(field), units, b.pictures, orderB);
                if (field !== 'path' || !withinAnEmu(valueA, valueB)) note(`${x.type} ${field}`, place, valueA, valueB);
            }
        }
    }
    return differences;
}

// The differences the writer explains, each with why it is no loss or a loss the writer accepts. A difference none
// matches is unlisted, and fails the gate.
export const PPTX_LISTED: Listed<RoundtripDifference, PptxRoundtripContext>[] = [
    {
        kind: 'pictures re-encoded',
        why: 'The export re-encodes a raster as PNG (a lossless source) or JPEG, no larger than OFFICE_IMAGE_MAX_SIZE, so its type or size comes back as the export made it',
        matches: ({ feature, at, b }, context) => {
            if (feature === 'image mediaName') {
                const element = elementAt(context.a, at);
                const name = element && 'mediaName' in element ? element.mediaName : '';
                return canonical(b) === canonical(context.prepared.get(name));
            }
            const background = backgroundOf(context.a, at);
            return (
                feature === 'slide background' &&
                background !== undefined &&
                canonical(b) === canonical({ ...background, mediaName: context.prepared.get(background.mediaName) })
            );
        },
    },
    {
        kind: 'text as the canvas lays it out',
        why: "The writer writes a text box as canvas-text.css lays it out: white space collapses, the space and the last line break CSS drops at a block's ends go, and a link is underlined, as the canvas draws it",
        matches: ({ feature, at, a, b }, context) => {
            if (feature === 'richtext html')
                return typeof a === 'string' && typeof b === 'string' && laidOut(a) === laidOut(b);
            const element = elementAt(context.a, at);
            return (
                feature === 'richtext textDecoration' &&
                a === 'none' &&
                b === 'underline' &&
                element?.type === 'richtext' &&
                !element.html
                    .replace(/<a\s[^>]*>.*?<\/a>/g, '')
                    .replace(/<[^>]*>/g, '')
                    .trim()
            );
        },
    },
    {
        kind: "a line's box is its points' box",
        why: 'A line or an arrow is written from its points, which a deck stores to the hundredth of a pixel, so its box comes back as their box, within an EMU: linearXml adds el.x and el.y to both points before segmentXml subtracts them, and the float error flips a half-EMU tie',
        matches: ({ feature, at, b }, context) => {
            const element = elementAt(context.a, at);
            if (!element || !('points' in element) || !/^(?:line|arrow|freedraw) (?:width|height)$/.test(feature))
                return false;
            const { minX, minY, maxX, maxY } = pointsBounds(parsePoints(element.points));
            const box = unitsOf(context.a.scene).emu(feature.endsWith('width') ? maxX - minX : maxY - minY);
            return typeof b === 'number' && Math.abs(b - box) <= 1;
        },
    },
    {
        kind: 'gradients as the canvas samples them',
        why: 'A gradient is written as the stops the canvas samples (gradientStops), where a fully transparent end carries no colour of its own, so its colour comes back as the canvas draws it',
        matches: ({ feature, a, b }) => {
            const [x, y] = [fields(Object(a)), fields(Object(b))];
            const stops = (fill: Map<string, unknown>) =>
                canonical(gradientStops(String(fill.get('from')), String(fill.get('to'))));
            const rest = (fill: Map<string, unknown>) =>
                canonical({ ...Object.fromEntries(fill), from: null, to: null });
            return (
                feature.endsWith(' fill') &&
                x.get('type') === 'gradient' &&
                y.get('type') === 'gradient' &&
                stops(x) === stops(y) &&
                rest(x) === rest(y)
            );
        },
    },
];

// What a text box shows of its HTML as canvas-text.css lays it out: white space collapses, the space and the breaks at
// a block's ends drop and an inline element left empty with them, and a link's own underline is the link's.
const INLINE = '(?:strong|em|u|s|a)';
const laidOut = (html: string) =>
    html
        .replace(/[\t\n\f\r ]+/g, ' ')
        .replace(new RegExp(`(?: |<br>)+((?:</${INLINE}>)*)</p>`, 'g'), '$1</p>')
        .replace(new RegExp(`<p>((?:<${INLINE}(?:\\s[^>]*)?>)*) `, 'g'), '<p>$1')
        .replace(/<(strong|em|u|s)><\/\1>/g, '')
        .replace(
            /(<a\s[^>]*>)(.*?)<\/a>/g,
            (_link, open: string, inner: string) => `${open}${inner.replace(/<\/?u>/g, '')}</a>`,
        );

// The slide and the element a difference's place names in a deck, as diffDecks names them.
function placeOf(deck: Deck, at: string): { frame?: VectorFrame; index?: number } {
    const [, slide, index] = /^slide (\d+)(?: #(\d+))?$/.exec(at) ?? [];
    return { frame: deck.scene.frames[Number(slide) - 1], index: index === undefined ? undefined : Number(index) };
}

function elementAt(deck: Deck, at: string): VectorElement | undefined {
    const { frame, index } = placeOf(deck, at);
    return frame && index !== undefined ? elementsInFrame(deck.scene.elements, frame.id)[index] : undefined;
}

function backgroundOf(deck: Deck, at: string): { mediaName: string } | undefined {
    const { frame } = placeOf(deck, at);
    const parsed: unknown = frame?.background ? JSON.parse(frame.background) : undefined;
    return typeof parsed === 'object' && parsed !== null && 'mediaName' in parsed
        ? { ...parsed, mediaName: String(parsed.mediaName) }
        : undefined;
}

export function classifyPptx(context: PptxRoundtripContext): DifferenceGroup[] {
    return classify(diffDecks(context.a, context.b), PPTX_LISTED, context);
}

// Each picture's type and size as sharp reads it.
async function picturesOf(media: ImportedMedia[]): Promise<Map<string, Picture>> {
    const { default: sharp } = await import('sharp');
    const pictures = new Map<string, Picture>();
    for (const { name, contentType, data } of media) {
        const { width, height } = await sharp(data)
            .metadata()
            .catch(() => ({ width: undefined, height: undefined }));
        pictures.set(name, { contentType, ...(width && height && { width, height }) });
    }
    return pictures;
}

const PRESENTATION = /\.p[po]t[xm](?![a-z0-9])/i;
const DEFAULT_WRITER = path.join(import.meta.dir, '../lib/export/slides/pptx/to-pptx.ts');

function isWriter(value: unknown): value is typeof writePptx {
    return typeof value === 'function';
}

const PPTX_GATE: RoundtripGate = {
    format: 'pptx',
    script: import.meta.path,
    pattern: PRESENTATION,
    noun: 'presentations',
    writer: DEFAULT_WRITER,
    listed: PPTX_LISTED,
};

// The round trip's child: the file imported into a deck as an import makes one, written by our writer with its
// pictures prepared as an export prepares them, imported again, and the two decks compared.
async function pptxRoundtripChild(
    file: string,
    options: { writer: string; reports: string; dump?: string },
): Promise<void> {
    const Y = await import('yjs');
    const { readVectorFromDoc } = await import('@workspace/lib/vector');
    const { importPptxToSlidesUpdate } = await import('../lib/import/slides/transform');
    const { sanitizeSceneHtml } = await import('../lib/export/sanitize');
    const { MAX_DECOMPRESSED_BYTES } = await import('../lib/ooxml/zip');
    const module: unknown = await import(options.writer);
    const write = typeof module === 'object' && module !== null && 'writePptx' in module && module.writePptx;
    if (!isWriter(write)) throw new Error(`${options.writer} exports no writePptx`);
    const read = async (data: ArrayBuffer): Promise<Deck & { warnings: TransformWarning[] }> => {
        const { update, images, warnings } = importPptxToSlidesUpdate(data, { maxMediaBytes: MAX_DECOMPRESSED_BYTES });
        const doc = new Y.Doc();
        Y.applyUpdate(doc, new Uint8Array(update));
        const media = images.map(({ name, contentType, data }) => ({ name, contentType, data: Buffer.from(data) }));
        return { scene: readVectorFromDoc(doc), media, pictures: new Map(), warnings };
    };
    await roundtripChild(options, async (step) => {
        const data = await Bun.file(file).arrayBuffer();
        const a = await step('import', () => read(data));
        const losses = lossCounter();
        let media: Awaited<ReturnType<typeof officeMedia>> = [];
        const bytes = await step('export', async () => {
            media = await officeMedia(a.media);
            return write(sanitizeSceneHtml(a.scene), { title: path.basename(file), media, lost: losses.lost });
        });
        const b = await step('reimport', () => read(new Uint8Array(bytes).slice().buffer));
        const groups = await step('compare', async () =>
            classifyPptx({
                a: { ...a, pictures: await picturesOf(a.media) },
                b: { ...b, pictures: await picturesOf(b.media) },
                prepared: await picturesOf(
                    media.map(({ name, contentType, data }) => ({ name, contentType, data: Buffer.from(data) })),
                ),
            }),
        );
        return {
            warnings: lossCounts(losses.warnings()),
            groups,
            charts: chartsNotImported(a.warnings, a.scene.elements),
        };
    });
}

export function runRoundtrip(options: RoundtripOptions): Promise<RoundtripMeta> {
    return runGate(PPTX_GATE, options);
}

if (import.meta.main) {
    const { values, positionals } = parseArgs({
        args: Bun.argv.slice(2),
        allowPositionals: true,
        options: {
            out: { type: 'string' },
            writer: { type: 'string' },
            timeout: { type: 'string' },
            'max-rss': { type: 'string' },
            reports: { type: 'string' },
            dump: { type: 'string' },
        },
    });
    const [command, ...rest] = positionals;
    if (command === 'roundtrip-child' && rest.length === 1 && values.writer && values.reports) {
        await pptxRoundtripChild(rest[0], { writer: values.writer, reports: values.reports, dump: values.dump });
    } else if (command === 'roundtrip' && rest.length > 0 && values.out) {
        const meta = await runRoundtrip({
            corpora: rest,
            out: values.out,
            writer: values.writer,
            dump: values.dump,
            timeoutMs: values.timeout ? Number(values.timeout) * 1000 : undefined,
            maxRssMb: values['max-rss'] ? Number(values['max-rss']) : undefined,
        });
        console.log(`${roundtripLine(meta)}: ${path.join(values.out, 'summary.md')}`);
        if (!meta.pass) process.exit(1);
    } else {
        console.error(
            'Usage: bun apps/api/src/scripts/pptx-audit.ts roundtrip <corpus dir...> --out <dir> [--writer <module>] [--dump <dir>] [--timeout <s>] [--max-rss <MB>]',
        );
        process.exit(1);
    }
}
