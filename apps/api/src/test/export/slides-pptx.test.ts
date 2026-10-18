import { describe, expect, test } from 'bun:test';
import { gradientStops } from '@workspace/lib/background';
import { sampleChartSpec } from '@workspace/lib/charts';
import type { BackgroundFill } from '@workspace/lib/types/background';
import {
    baseDefaultsFor,
    convertToShapes,
    ELEMENT_KINDS,
    FRAME_FIELDS,
    readVectorFromDoc,
    SLIDES_STYLE_DEFAULTS,
    type SlideSize,
    serializeBackgroundFill,
    serializeFill,
    type VectorElementType,
    type VectorScene,
} from '@workspace/lib/vector';
import * as Y from 'yjs';
import { parseOoxml } from '../../lib/core/ooxml';
import { type XmlElement, xmlAttr, xmlChild, xmlElements, xmlText } from '../../lib/core/xml';
import { openZip, type ZipReader } from '../../lib/core/zip';
import { toTransferableText } from '../../lib/document/transform/protocol';
import type { OfficeMedia } from '../../lib/export/office-image';
import { sanitizeSceneHtml } from '../../lib/export/sanitize';
import { eigenslidesToPptx } from '../../lib/export/slides/to-pptx';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const ASVG = 'http://schemas.microsoft.com/office/drawing/2016/SVG/main';

// 16:9: 12,192,000 EMU over 1920 px.
const EMU = 6350;

type Fields = Record<string, unknown>;
type FrameSpec = { id: string; index: string; name?: string; background?: BackgroundFill | null };

// An element as a new one on a slide is created, then the test's fields: the stored shape a peer writes.
function element(type: VectorElementType, over: Fields): Fields {
    return {
        ...baseDefaultsFor(type, SLIDES_STYLE_DEFAULTS),
        ...ELEMENT_KINDS[type].defaults(SLIDES_STYLE_DEFAULTS),
        id: `${type}-${String(over['index'] ?? 'a0')}`,
        type,
        index: 'a0',
        frameId: 'f1',
        x: 100,
        y: 50,
        width: 200,
        height: 100,
        angle: 0,
        ...over,
    };
}

function deckDoc(frames: FrameSpec[], elements: Fields[], slideSize?: SlideSize): Y.Doc {
    const doc = new Y.Doc();
    doc.transact(() => {
        if (slideSize) doc.getMap('meta').set('slideSize', slideSize);
        for (const spec of frames) {
            const frame = new Y.Map<unknown>();
            const values: Fields = {
                id: spec.id,
                index: spec.index,
                name: spec.name ?? '',
                background: serializeBackgroundFill(
                    spec.background === undefined ? { type: 'solid', color: '#ffffff' } : spec.background,
                ),
            };
            for (const field of FRAME_FIELDS) frame.set(field, values[field]);
            doc.getMap('frames').set(spec.id, frame);
        }
        for (const fields of elements) {
            const map = new Y.Map<unknown>();
            for (const [key, value] of Object.entries(fields)) map.set(key, value);
            doc.getMap('elements').set(String(fields['id']), map);
        }
    });
    return doc;
}

// The scene as the transform reads it: the reader, then the export's rich-text filter.
function sceneOf(
    elements: Fields[],
    frames: FrameSpec[] = [{ id: 'f1', index: 'a0' }],
    slideSize?: SlideSize,
): VectorScene {
    return sanitizeSceneHtml(readVectorFromDoc(deckDoc(frames, elements, slideSize)));
}

function pptx(scene: VectorScene, media: OfficeMedia[] = []): ZipReader {
    return openZip(eigenslidesToPptx(scene, media, 'Deck & <co>.eigenslides'));
}

function part(zip: ZipReader, path: string): XmlElement {
    const data = zip.read(path);
    const root = data && parseOoxml(data);
    if (!root) throw new Error(`${path} missing or blank`);
    return root;
}

function descendants(root: XmlElement, ns: string, local: string): XmlElement[] {
    const out: XmlElement[] = [];
    for (const child of xmlElements(root)) {
        if (child.ns === ns && child.local === local) out.push(child);
        out.push(...descendants(child, ns, local));
    }
    return out;
}

function first(root: XmlElement, ns: string, local: string): XmlElement {
    const found = descendants(root, ns, local)[0];
    if (!found) throw new Error(`no ${local}`);
    return found;
}

function attr(element: XmlElement | undefined, local: string): string | undefined {
    return element && xmlAttr(element, '', local);
}

// The shapes of slide n, in tree order: every child of p:spTree past its group properties.
function shapes(zip: ZipReader, n = 1): XmlElement[] {
    const tree = first(part(zip, `ppt/slides/slide${n}.xml`), P, 'spTree');
    return xmlElements(tree).filter((child) => child.local !== 'nvGrpSpPr' && child.local !== 'grpSpPr');
}

function only(zip: ZipReader): XmlElement {
    const all = shapes(zip);
    expect(all).toHaveLength(1);
    return all[0];
}

function xfrm(shape: XmlElement): { x: number; y: number; cx: number; cy: number; rot: number } {
    const transform = first(shape, A, 'xfrm');
    const off = xmlChild(transform, A, 'off');
    const ext = xmlChild(transform, A, 'ext');
    return {
        x: Number(attr(off, 'x')),
        y: Number(attr(off, 'y')),
        cx: Number(attr(ext, 'cx')),
        cy: Number(attr(ext, 'cy')),
        rot: Number(attr(transform, 'rot') ?? 0),
    };
}

function geometry(shape: XmlElement): string {
    const preset = descendants(shape, A, 'prstGeom')[0];
    return preset ? String(attr(preset, 'prst')) : descendants(shape, A, 'custGeom').length ? 'custom' : 'none';
}

function guides(shape: XmlElement): Record<string, number> {
    return Object.fromEntries(
        descendants(shape, A, 'gd').map((gd) => [attr(gd, 'name'), Number(attr(gd, 'fmla')?.replace('val ', ''))]),
    );
}

function relationships(zip: ZipReader, path: string): Map<string, { type: string; target: string; mode?: string }> {
    const at = path.lastIndexOf('/');
    const rels = part(zip, `${path.slice(0, at)}/_rels/${path.slice(at + 1)}.rels`);
    return new Map(
        xmlElements(rels).map((rel) => [
            String(attr(rel, 'Id')),
            { type: String(attr(rel, 'Type')), target: String(attr(rel, 'Target')), mode: attr(rel, 'TargetMode') },
        ]),
    );
}

// The text of each paragraph of a shape, runs joined, a:br as a newline.
function paragraphs(shape: XmlElement): string[] {
    return descendants(shape, A, 'p').map((p) =>
        xmlElements(p)
            .map((child) => (child.local === 'br' ? '\n' : child.local === 'r' ? xmlText(first(child, A, 't')) : ''))
            .join(''),
    );
}

function runs(shape: XmlElement): XmlElement[] {
    return descendants(shape, A, 'r');
}

function runText(run: XmlElement): string {
    return xmlText(first(run, A, 't'));
}

function runProps(shape: XmlElement, text: string): XmlElement {
    const run = runs(shape).find((r) => runText(r) === text);
    if (!run) throw new Error(`no run ${text}`);
    return first(run, A, 'rPr');
}

function srgb(element: XmlElement): { val?: string; alpha?: number } {
    const color = first(element, A, 'srgbClr');
    const alpha = xmlChild(color, A, 'alpha');
    return { val: attr(color, 'val'), alpha: alpha ? Number(attr(alpha, 'val')) : undefined };
}

const PNG_MEDIA: OfficeMedia = {
    name: 'wide.png',
    contentType: 'image/png',
    data: toTransferableText('wide png'),
    width: 400,
    height: 100,
};

describe('pptx package', () => {
    test('one slide per frame in frame order, every part typed and every relationship resolved', () => {
        const scene = sceneOf(
            [
                element('rectangle', { id: 'on-second', frameId: 'f-second' }),
                element('ellipse', { id: 'on-first', frameId: 'f-first' }),
                element('image', { id: 'pic', frameId: 'f-first', index: 'a1', mediaName: 'wide.png' }),
            ],
            [
                { id: 'f-second', index: 'a1' },
                { id: 'f-first', index: 'a0' },
                { id: 'f-empty', index: 'a2' },
            ],
        );
        const zip = pptx(scene, [PNG_MEDIA]);

        const presentation = part(zip, 'ppt/presentation.xml');
        const slideIds = descendants(presentation, P, 'sldId');
        expect(slideIds).toHaveLength(3);
        const presentationRels = relationships(zip, 'ppt/presentation.xml');
        const targets = slideIds.map((id) => presentationRels.get(String(xmlAttr(id, R, 'id')))?.target);
        expect(targets).toEqual(['slides/slide1.xml', 'slides/slide2.xml', 'slides/slide3.xml']);
        expect(geometry(shapes(zip, 1)[0])).toBe('ellipse');
        expect(geometry(shapes(zip, 2)[0])).toBe('roundRect');
        expect(shapes(zip, 3)).toHaveLength(0);

        // Every part has a content type, every internal target exists.
        const types = part(zip, '[Content_Types].xml');
        const defaults = new Set(descendants(types, CONTENT_TYPES, 'Default').map((d) => attr(d, 'Extension')));
        const overrides = new Set(descendants(types, CONTENT_TYPES, 'Override').map((o) => attr(o, 'PartName')));
        for (const name of zip.names()) {
            if (name === '[Content_Types].xml') continue;
            const typed = overrides.has(`/${name}`) || defaults.has(name.slice(name.lastIndexOf('.') + 1));
            expect(typed, name).toBe(true);
        }
        for (const name of zip.names().filter((n) => n.endsWith('.rels'))) {
            const dir = name.replace(/_rels\/[^/]*\.rels$/, '');
            for (const rel of xmlElements(part(zip, name))) {
                if (attr(rel, 'TargetMode') === 'External') continue;
                const target = new URL(String(attr(rel, 'Target')), `file:///${dir}`).pathname.slice(1);
                expect(zip.names(), `${name} → ${target}`).toContain(target);
            }
        }
        expect(relationships(zip, 'ppt/slides/slide1.xml').size).toBe(2);
        expect(zip.names().filter((n) => n.startsWith('ppt/media/'))).toEqual(['ppt/media/image1.png']);
    });

    test('the same deck writes the same bytes', () => {
        const scene = sceneOf([
            element('richtext', { html: '<p>Hello <a href="https://example.com">there</a></p>' }),
            element('image', { index: 'a1', mediaName: 'wide.png', objectFit: 'cover' }),
        ]);
        expect(eigenslidesToPptx(scene, [PNG_MEDIA], 'Deck')).toEqual(eigenslidesToPptx(scene, [PNG_MEDIA], 'Deck'));
    });

    test('a deck with no frames is the empty deck', () => {
        expect(() => eigenslidesToPptx(sceneOf([], []), [], 'Deck')).toThrow('The deck is empty');
    });

    test("the slide size is the deck's: 16:9 and 4:3", () => {
        const wideScene = sceneOf([element('rectangle', { corners: 'straight' })]);
        const wide = pptx(wideScene);
        const wideSize = first(part(wide, 'ppt/presentation.xml'), P, 'sldSz');
        expect([attr(wideSize, 'cx'), attr(wideSize, 'cy')]).toEqual(['12192000', '6858000']);
        expect(xfrm(only(wide))).toEqual({ x: 100 * EMU, y: 50 * EMU, cx: 200 * EMU, cy: 100 * EMU, rot: 0 });
        // The size is the deck's meta, not its frames' shape.
        const relabeled = pptx({ ...wideScene, meta: { ...wideScene.meta, slideSize: '4:3' } });
        expect(attr(first(part(relabeled, 'ppt/presentation.xml'), P, 'sldSz'), 'cx')).toBe('9144000');

        const square = pptx(
            sceneOf(
                [
                    element('rectangle', { corners: 'straight', x: 192, y: 144 }),
                    element('richtext', { index: 'a1', html: '<p>small</p>', fontSize: 48 }),
                ],
                undefined,
                '4:3',
            ),
        );
        const squareSize = first(part(square, 'ppt/presentation.xml'), P, 'sldSz');
        expect([attr(squareSize, 'cx'), attr(squareSize, 'cy')]).toEqual(['9144000', '6858000']);
        const [rectangle, text] = shapes(square);
        // 4,762.5 EMU per px, rounded to whole EMU.
        expect(xfrm(rectangle)).toEqual({ x: 914400, y: 685800, cx: 952500, cy: 476250, rot: 0 });
        // Text shrinks with the slide: 48 px at 0.375 pt per px.
        expect(attr(runProps(text, 'small'), 'sz')).toBe('1800');
    });

    test('an element wholly outside its frame is not written, one the canvas draws any of is', () => {
        const zip = pptx(
            sceneOf([
                element('rectangle', { index: 'a0', x: -100, width: 200 }),
                element('rectangle', { index: 'a1', x: 2000 }),
                element('rectangle', { index: 'a2', x: -500, y: 2000 }),
                element('ellipse', { index: 'a3', x: 1_000_000, y: 1_000_000 }),
                element('line', { index: 'a4', x: 3000, points: '[[0,0],[100,50],[0,100]]' }),
                // A line draws its points, not its box: in the frame with every point past it, and the other way.
                element('line', { index: 'a5', width: 10, height: 10, points: '[[5000,0],[6000,0]]' }),
                element('line', { index: 'a6', x: 3000, width: 10, height: 10, points: '[[0,0],[-2950,0]]' }),
                // 10 px left of the frame, its 40 px stroke reaching 10 px in.
                element('rectangle', { index: 'a7', x: -210, strokeWidth: 40 }),
                // A freehand stroke's ink is FREEDRAW_SIZE_FACTOR its stroke: 21 px wide, 0.6 px in.
                element('freedraw', {
                    index: 'a8',
                    x: -60,
                    width: 50,
                    height: 0,
                    strokeWidth: 10,
                    points: '[[0,0],[50,0]]',
                }),
                // A million px wide and 1000 px in, its offset past 32 bits of EMU.
                element('rectangle', { index: 'a9', x: -999_000, width: 1_000_000 }),
            ]),
        );
        const all = shapes(zip);
        expect(all.map((shape) => attr(first(shape, P, 'cNvPr'), 'name')?.split(' ')[0])).toEqual([
            'Rectangle',
            'Line',
            'Rectangle',
            'Ink',
            'Rectangle',
        ]);
        expect([all[0], all[1], all[2], all[4]].map((shape) => xfrm(shape).x)).toEqual([
            -100 * EMU,
            50 * EMU,
            -210 * EMU,
            -999_000 * EMU,
        ]);
    });

    test("a coordinate past ST_Coordinate's range is written at its bound", () => {
        const scene = sceneOf([
            element('rectangle', { index: 'a0', corners: 'straight' }),
            element('line', { index: 'a1', points: '[[0,0],[100,0],[0,100]]', roundness: 'sharp' }),
        ]);
        // Past what the reader keeps, which the writer's output stays valid without.
        const far = {
            ...scene,
            elements: scene.elements.map((el) => ({
                ...el,
                x: -1e10,
                width: 2e10,
                ...(el.type === 'line' ? { points: '[[0,0],[2e10,0],[0,100]]' } : {}),
            })),
        };
        const [rectangle, line] = shapes(pptx(far));
        const MAX_COORDINATE = 27_273_042_316_900;
        expect(xfrm(rectangle)).toMatchObject({ x: -MAX_COORDINATE, cx: MAX_COORDINATE });
        const points = descendants(line, A, 'pt').map((pt) => Number(attr(pt, 'x')));
        expect(Math.max(...points)).toBe(MAX_COORDINATE);
        expect(Number(attr(first(line, A, 'path'), 'w'))).toBe(MAX_COORDINATE);
    });

    test('the deck title is escaped into the core properties', () => {
        const core = part(pptx(sceneOf([])), 'docProps/core.xml');
        expect(xmlText(first(core, 'http://purl.org/dc/elements/1.1/', 'title'))).toBe('Deck & <co>');
    });
});

describe('pptx shapes', () => {
    test('corners pick rect or roundRect with the radius Eigen draws', () => {
        const zip = pptx(
            sceneOf([
                element('rectangle', { index: 'a0', corners: 'straight' }),
                element('rectangle', { index: 'a1', corners: 'curved' }),
                element('rectangle', { index: 'a2', corners: 'round' }),
            ]),
        );
        const [straight, curved, round] = shapes(zip);
        expect(geometry(straight)).toBe('rect');
        expect(geometry(curved)).toBe('roundRect');
        // curved: min(100 × 0.25, 32) over the short side 100.
        expect(guides(curved)).toEqual({ adj: 25000 });
        expect(guides(round)).toEqual({ adj: 50000 });
    });

    test('rotation is the angle in 60,000ths, ellipses and straight diamonds are presets', () => {
        const zip = pptx(
            sceneOf([
                element('ellipse', { index: 'a0', angle: 30 }),
                element('diamond', { index: 'a1', corners: 'straight', angle: 359.5 }),
            ]),
        );
        const [ellipse, diamond] = shapes(zip);
        expect(geometry(ellipse)).toBe('ellipse');
        expect(xfrm(ellipse).rot).toBe(1_800_000);
        expect(geometry(diamond)).toBe('diamond');
        expect(xfrm(diamond).rot).toBe(21_570_000);
    });

    test('a rounded diamond is its outline: four edges joined by arcs', () => {
        const shape = only(pptx(sceneOf([element('diamond', { corners: 'curved' })])));
        expect(geometry(shape)).toBe('custom');
        expect(descendants(shape, A, 'lnTo')).toHaveLength(4);
        expect(descendants(shape, A, 'arcTo')).toHaveLength(4);
        const path = first(shape, A, 'path');
        expect([attr(path, 'w'), attr(path, 'h')]).toEqual([String(200 * EMU), String(100 * EMU)]);
    });

    test('a pie writes visual angles that read back to the stored slice', () => {
        const startAngle = 300;
        const sweepAngle = 100;
        const shape = only(pptx(sceneOf([element('pie', { width: 400, height: 100, startAngle, sweepAngle })])));
        expect(geometry(shape)).toBe('pie');
        const { adj1, adj2 } = guides(shape);
        // The inverse: θ_param = atan2(rx·sinθ, ry·cosθ), rx 200 and ry 50.
        const param = (visual: number) => {
            const theta = (visual / 60000) * (Math.PI / 180);
            return (((Math.atan2(200 * Math.sin(theta), 50 * Math.cos(theta)) * 180) / Math.PI + 360) % 360) as number;
        };
        expect(param(adj1)).toBeCloseTo(startAngle, 2);
        expect(param(adj2)).toBeCloseTo((startAngle + sweepAngle) % 360, 2);
        // A squashed box moves the visual angle off the stored one.
        expect(Math.abs(adj1 / 60000 - startAngle)).toBeGreaterThan(5);

        const whole = only(pptx(sceneOf([element('pie', { sweepAngle: 360 })])));
        expect(geometry(whole)).toBe('ellipse');
    });

    test('a slice too thin to tell its angles apart writes nothing, one too full to an ellipse', () => {
        // DrawingML's pie draws a whole disc when its two angles meet.
        const thin = pptx(sceneOf([element('pie', { startAngle: 30, sweepAngle: 1e-7 })]));
        expect(shapes(thin)).toHaveLength(0);
        const full = only(pptx(sceneOf([element('pie', { startAngle: 30, sweepAngle: 360 - 1e-7 })])));
        expect(geometry(full)).toBe('ellipse');

        const spec = sampleChartSpec('pie');
        const series = spec.data.series.map((s) => ({ ...s, values: [1.4e9, 3, 65, 80] }));
        const chart = element('chart', {
            width: 640,
            height: 400,
            chart: JSON.stringify({ ...spec, data: { ...spec.data, series } }),
        });
        const scene = sceneOf([chart]);
        const all = shapes(pptx(scene));
        // The 3's slice is the one under a 60,000th of a degree.
        expect(all).toHaveLength(convertToShapes(scene.elements[0]).length - 1);
        const pies = all.filter((shape) => geometry(shape) === 'pie');
        expect(pies).toHaveLength(3);
        for (const pie of pies) expect(guides(pie)['adj1']).not.toBe(guides(pie)['adj2']);
    });

    test('a fill, a #rrggbbaa stroke, opacity and dashes', () => {
        const shape = only(
            pptx(
                sceneOf([
                    element('rectangle', {
                        fill: serializeFill({ type: 'solid', color: '#ff8000', style: 'hachure' }),
                        strokeColor: '#11223380',
                        strokeWidth: 4,
                        strokeStyle: 'dashed',
                        opacity: 50,
                    }),
                ]),
            ),
        );
        const spPr = first(shape, P, 'spPr');
        // A hatched fill exports solid.
        expect(srgb(first(spPr, A, 'solidFill'))).toEqual({ val: 'FF8000', alpha: 50000 });
        const line = first(spPr, A, 'ln');
        expect(attr(line, 'w')).toBe(String(4 * EMU));
        // 0x80 / 255 of the color, times the element's half opacity.
        expect(srgb(line)).toEqual({ val: '112233', alpha: 25098 });
        expect(attr(first(line, A, 'prstDash'), 'val')).toBe('dash');
    });

    test('a transparent fill and border write none, a gradient fill its stops', () => {
        const [plain, gradient] = shapes(
            pptx(
                sceneOf([
                    element('ellipse', { index: 'a0', strokeColor: 'transparent' }),
                    element('ellipse', {
                        index: 'a1',
                        fill: serializeFill({
                            type: 'gradient',
                            from: '#ff0000',
                            to: '#0000ff',
                            angle: 180,
                            style: 'solid',
                        }),
                    }),
                ]),
            ),
        );
        const spPr = first(plain, P, 'spPr');
        expect(xmlChild(spPr, A, 'noFill')).toBeDefined();
        expect(xmlChild(first(spPr, A, 'ln'), A, 'noFill')).toBeDefined();
        const fill = first(gradient, A, 'gradFill');
        const stops = descendants(fill, A, 'gs');
        expect(srgb(stops[0]).val).toBe('FF0000');
        expect(srgb(stops[stops.length - 1]).val).toBe('0000FF');
        // CSS 180deg paints top to bottom: DrawingML's 90°.
        expect(attr(first(fill, A, 'lin'), 'ang')).toBe('5400000');
    });

    test("a gradient runs as the canvas stretches it with the element's box", () => {
        const shape = only(
            pptx(
                sceneOf([
                    element('rectangle', {
                        width: 400,
                        height: 100,
                        fill: serializeFill({
                            type: 'gradient',
                            from: '#ff0000',
                            to: '#0000ff',
                            angle: 45,
                            style: 'solid',
                        }),
                    }),
                ]),
            ),
        );
        // gradientVector's 45deg runs corner to corner in the box's own units, so on a 4:1 box its stops meet the
        // top-left and bottom-right corners halfway: the true angle is the normal of that diagonal, (1, −4).
        const lin = first(first(shape, A, 'gradFill'), A, 'lin');
        const normal = (Math.atan2(-4, 1) * 180) / Math.PI + 360;
        expect(Number(attr(lin, 'ang'))).toBe(Math.round(normal * 60_000));
        expect(attr(lin, 'scaled')).toBe('0');
    });

    test("a gradient writes Eigen's OKLab ramp as its stops, element and background alike", () => {
        const red = '#ff0000';
        const blue = '#0000ff';
        const zip = pptx(
            sceneOf(
                [
                    element('rectangle', {
                        fill: serializeFill({ type: 'gradient', from: red, to: blue, angle: 90, style: 'solid' }),
                    }),
                ],
                [{ id: 'f1', index: 'a0', background: { type: 'gradient', from: red, to: blue, angle: 90 } }],
            ),
        );
        const ramp = gradientStops(red, blue);
        expect(ramp).toHaveLength(9);
        // PowerPoint interpolates its stops in sRGB, whose midpoint is 800080.
        expect(ramp[4].color.toUpperCase()).not.toBe('#800080');
        const slide = part(zip, 'ppt/slides/slide1.xml');
        for (const fill of [first(first(slide, P, 'bgPr'), A, 'gradFill'), first(only(zip), A, 'gradFill')]) {
            const stops = descendants(fill, A, 'gs').map((gs) => [Number(attr(gs, 'pos')), srgb(gs).val]);
            expect(stops).toEqual(ramp.map((stop) => [stop.offset * 100_000, stop.color.slice(1).toUpperCase()]));
        }
    });

    test('a two-point arrow is a connector line, flipped toward its end, with its heads', () => {
        const zip = pptx(
            sceneOf([
                element('arrow', {
                    index: 'a0',
                    x: 100,
                    y: 100,
                    width: 300,
                    height: 50,
                    points: '[[300,0],[0,50]]',
                    startArrowhead: 'circle',
                    endArrowhead: 'triangle',
                    roundness: 'sharp',
                }),
                element('line', { index: 'a1', points: '[[0,0],[200,100]]', strokeStyle: 'dotted' }),
            ]),
        );
        const [arrow, line] = shapes(zip);
        expect(arrow.local).toBe('cxnSp');
        expect(geometry(arrow)).toBe('line');
        expect(xfrm(arrow)).toEqual({ x: 100 * EMU, y: 100 * EMU, cx: 300 * EMU, cy: 50 * EMU, rot: 0 });
        const transform = first(arrow, A, 'xfrm');
        expect([attr(transform, 'flipH'), attr(transform, 'flipV')]).toEqual(['1', undefined]);
        const ln = first(arrow, A, 'ln');
        expect(attr(first(ln, A, 'headEnd'), 'type')).toBe('oval');
        expect(attr(first(ln, A, 'tailEnd'), 'type')).toBe('triangle');
        expect(line.local).toBe('cxnSp');
        expect(attr(first(line, A, 'prstDash'), 'val')).toBe('dot');
    });

    test('a bar head is a short line across the tip', () => {
        const zip = pptx(
            sceneOf([
                element('arrow', {
                    points: '[[0,0],[200,0]]',
                    height: 0,
                    startArrowhead: 'none',
                    endArrowhead: 'bar',
                }),
            ]),
        );
        const [shaft, bar] = shapes(zip);
        expect(descendants(shaft, A, 'tailEnd')).toHaveLength(0);
        expect(geometry(bar)).toBe('line');
        // Across the shaft at its end: vertical, centered on the tip.
        const box = xfrm(bar);
        expect(box.cx).toBe(0);
        expect(box.x).toBe(300 * EMU);
        expect(box.y + box.cy / 2).toBe(50 * EMU);
    });

    test('a polyline, a curved line, an elbow arrow and a freehand stroke are paths', () => {
        const zip = pptx(
            sceneOf([
                element('line', { index: 'a0', points: '[[0,0],[100,100],[200,0]]', roundness: 'sharp' }),
                element('line', { index: 'a1', points: '[[0,0],[100,100],[200,0]]', roundness: 'round' }),
                element('arrow', {
                    index: 'a2',
                    points: '[[0,0],[200,100]]',
                    elbow: true,
                    startArrowhead: 'none',
                    endArrowhead: 'arrow',
                }),
                element('freedraw', { index: 'a3', points: '[[0,0],[10,5],[20,30],[60,80]]' }),
                element('line', {
                    index: 'a4',
                    points: '[[0,0],[200,0],[100,100],[0,0]]',
                    roundness: 'sharp',
                    fill: serializeFill({ type: 'solid', color: '#00ff00', style: 'solid' }),
                }),
            ]),
        );
        const [polyline, curve, elbow, stroke, closed] = shapes(zip);
        expect(geometry(polyline)).toBe('custom');
        expect(descendants(polyline, A, 'lnTo')).toHaveLength(2);
        expect(attr(first(polyline, A, 'path'), 'fill')).toBe('none');
        expect(descendants(curve, A, 'cubicBezTo')).toHaveLength(2);
        expect(geometry(elbow)).toBe('custom');
        expect(descendants(elbow, A, 'lnTo').length).toBeGreaterThan(1);
        expect(attr(first(elbow, A, 'tailEnd'), 'type')).toBe('arrow');
        // A freehand stroke is its ink: the outline the canvas fills, in the stroke color, with no line.
        expect(descendants(stroke, A, 'quadBezTo').length).toBeGreaterThan(4);
        expect(srgb(first(first(stroke, P, 'spPr'), A, 'solidFill')).val).toBe('1E1E1E');
        expect(xmlChild(first(stroke, A, 'ln'), A, 'noFill')).toBeDefined();
        expect(descendants(closed, A, 'close')).toHaveLength(1);
        expect(srgb(first(first(closed, P, 'spPr'), A, 'solidFill')).val).toBe('00FF00');
    });

    test("a path is its box's custGeom, each command its DrawingML one in EMU; an open path fills none", () => {
        const fill = serializeFill({ type: 'solid', color: '#00ff00', style: 'cross-hatch' });
        const zip = pptx(
            sceneOf([
                element('path', {
                    index: 'a0',
                    path: 'M 0 0 L 1 0 C 1 0.5 0.5 1 0 1 Z M 0.25 0.25 Q 0.5 0.75 0.75 0.25 Z',
                    closed: true,
                    fill,
                    strokeColor: '#0000ff',
                    strokeWidth: 2,
                }),
                element('path', { index: 'a1', path: 'M 0 0 L 0.5 1 L 1 0', closed: false, fill }),
            ]),
        );
        const [closed, open] = shapes(zip);
        expect(geometry(closed)).toBe('custom');
        const path = first(closed, A, 'path');
        expect([attr(path, 'w'), attr(path, 'h'), attr(path, 'fill')]).toEqual([
            String(200 * EMU),
            String(100 * EMU),
            undefined,
        ]);
        expect(xmlElements(path).map((command) => command.local)).toEqual([
            'moveTo',
            'lnTo',
            'cubicBezTo',
            'close',
            'moveTo',
            'quadBezTo',
            'close',
        ]);
        const points = (command: string) =>
            descendants(first(path, A, command), A, 'pt').map((pt) => [Number(attr(pt, 'x')), Number(attr(pt, 'y'))]);
        expect(points('cubicBezTo')).toEqual([
            [200 * EMU, 50 * EMU],
            [100 * EMU, 100 * EMU],
            [0, 100 * EMU],
        ]);
        expect(points('quadBezTo')).toEqual([
            [100 * EMU, 75 * EMU],
            [150 * EMU, 25 * EMU],
        ]);
        // A hatched fill writes solid, as every kind's does.
        expect(srgb(first(first(closed, P, 'spPr'), A, 'solidFill')).val).toBe('00FF00');
        expect(srgb(first(closed, A, 'ln')).val).toBe('0000FF');
        expect(attr(first(open, A, 'path'), 'fill')).toBe('none');
        expect(xmlChild(first(open, P, 'spPr'), A, 'noFill')).toBeDefined();
        expect(descendants(open, A, 'close')).toHaveLength(0);
    });

    // Past what a spread into Math.max takes: about 500k arguments in a Worker, 640k on the main thread.
    test('a looping freehand stroke of 700k points writes its fill and its ink', () => {
        const raster = Array.from({ length: 700_000 }, (_, i) => [i % 1000, Math.floor(i / 1000)]);
        const zip = pptx(
            sceneOf([
                element('freedraw', {
                    points: JSON.stringify([...raster, [0, 0]]),
                    width: 1000,
                    height: 700,
                    fill: serializeFill({ type: 'solid', color: '#00ff00', style: 'solid' }),
                }),
            ]),
        );
        // Read as text: parsing a million path points into a tree takes seconds.
        const slide = new TextDecoder().decode(zip.read('ppt/slides/slide1.xml'));
        expect(slide.match(/<p:sp>/g)).toHaveLength(2);
    });

    test('a looping freehand stroke with no fill writes only its ink', () => {
        const shape = only(
            pptx(
                sceneOf([
                    element('freedraw', {
                        points: '[[0,0],[100,0],[50,80],[0,0]]',
                        fill: serializeFill({ type: 'solid', color: 'transparent', style: 'solid' }),
                    }),
                ]),
            ),
        );
        expect(attr(first(shape, P, 'cNvPr'), 'name')).toStartWith('Ink');
    });

    test("an arrow label is a centered text box at the label anchor, over the slide's color where the canvas masks", () => {
        const [, ground, label] = shapes(
            pptx(
                sceneOf([
                    element('arrow', {
                        points: '[[0,0],[400,0]]',
                        width: 400,
                        height: 0,
                        text: 'yes <no>',
                        labelWidth: 80,
                        fontSize: 20,
                    }),
                ]),
            ),
        );
        expect(paragraphs(label)).toEqual(['yes <no>']);
        expect(attr(first(label, A, 'pPr'), 'algn')).toBe('ctr');
        const box = xfrm(label);
        expect(box.x + box.cx / 2).toBe(300 * EMU);
        expect(box.y + box.cy / 2).toBe(50 * EMU);
        // Google Slides wraps a box set not to, so the text's box holds an em per character: one line anywhere.
        expect(attr(first(label, A, 'bodyPr'), 'wrap')).toBe('none');
        expect(box.cx).toBeGreaterThanOrEqual('yes <no>'.length * 20 * EMU);
        expect(descendants(first(label, P, 'spPr'), A, 'noFill')).not.toHaveLength(0);
        // The mask is the label's own width and Eigen's 5 px around it, in the slide's color.
        expect(descendants(ground, P, 'txBody')).toHaveLength(0);
        expect(xfrm(ground)).toEqual({ ...box, x: 255 * EMU, cx: 90 * EMU });
        expect(srgb(first(first(ground, P, 'spPr'), A, 'solidFill')).val).toBe('FFFFFF');
    });

    test('a chart is written as the shapes Convert to shapes makes, each with its own id', () => {
        const chart = element('chart', {
            width: 640,
            height: 400,
            chart: JSON.stringify(sampleChartSpec('pie')),
        });
        const scene = sceneOf([chart]);
        const expected = convertToShapes(scene.elements[0]);
        expect(expected.length).toBeGreaterThan(3);
        const all = shapes(pptx(scene));
        expect(all).toHaveLength(expected.length);
        expect(all.some((shape) => geometry(shape) === 'pie')).toBe(true);
        const ids = all.map((shape) => attr(first(shape, P, 'cNvPr'), 'id'));
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).not.toContain('1');
    });
});

describe('pptx text', () => {
    test('a box writes its typography at the deck scale', () => {
        const shape = only(
            pptx(
                sceneOf([
                    element('richtext', {
                        html: '<p>Title</p>',
                        fontFamily: 'Source Serif 4',
                        fontSize: 48,
                        fontWeight: 'bold',
                        fontStyle: 'italic',
                        textDecoration: 'underline',
                        textAlign: 'center',
                        verticalAlign: 'bottom',
                        color: '#336699',
                        letterSpacing: 2,
                        lineHeight: 1.5,
                        padding: 10,
                    }),
                ]),
            ),
        );
        expect(attr(first(shape, P, 'cNvSpPr'), 'txBox')).toBe('1');
        const body = first(shape, A, 'bodyPr');
        expect(attr(body, 'anchor')).toBe('b');
        expect([attr(body, 'lIns'), attr(body, 'tIns'), attr(body, 'rIns'), attr(body, 'bIns')]).toEqual(
            Array(4).fill(String(10 * EMU)),
        );
        expect(attr(first(shape, A, 'pPr'), 'algn')).toBe('ctr');
        // CSS's pitch, 1.5 × 48 px, exactly: 36 pt.
        expect(attr(first(first(shape, A, 'lnSpc'), A, 'spcPts'), 'val')).toBe('3600');
        const rPr = runProps(shape, 'Title');
        // 48 px at 0.5 pt per px is 24 pt; 2 px of spacing is 1 pt.
        expect([attr(rPr, 'sz'), attr(rPr, 'b'), attr(rPr, 'i'), attr(rPr, 'u'), attr(rPr, 'spc')]).toEqual([
            '2400',
            '1',
            '1',
            'sng',
            '100',
        ]);
        expect(srgb(rPr).val).toBe('336699');
        expect(attr(first(rPr, A, 'latin'), 'typeface')).toBe('Source Serif 4');
    });

    test('a painted rounded box is its outline, so the text keeps the whole box; an unpainted one is a rect', () => {
        const [painted, bare] = shapes(
            pptx(
                sceneOf([
                    element('richtext', { index: 'a0', html: '<p>a</p>', corners: 'curved', strokeColor: '#000000' }),
                    element('richtext', { index: 'a1', html: '<p>b</p>', corners: 'round' }),
                ]),
            ),
        );
        expect(geometry(painted)).toBe('custom');
        expect(descendants(painted, A, 'arcTo')).toHaveLength(4);
        expect(attr(first(painted, A, 'rect'), 'r')).toBe('r');
        expect(geometry(bare)).toBe('rect');
    });

    test('inline marks, links, breaks and paragraphs', () => {
        const zip = pptx(
            sceneOf([
                element('richtext', {
                    html:
                        '<p>plain <strong>bold <em>both</em></strong> <u>under</u> <s>gone</s></p>' +
                        '<p>a<br>b <a href="https://example.com/?a=1&amp;b=&quot;2&quot;">link</a></p><p></p>',
                }),
            ]),
        );
        const shape = only(zip);
        expect(paragraphs(shape)).toEqual(['plain bold both under gone', 'a\nb link', '']);
        expect(attr(runProps(shape, 'bold '), 'b')).toBe('1');
        expect([attr(runProps(shape, 'both'), 'b'), attr(runProps(shape, 'both'), 'i')]).toEqual(['1', '1']);
        expect(attr(runProps(shape, 'plain '), 'b')).toBeUndefined();
        expect(attr(runProps(shape, 'under'), 'u')).toBe('sng');
        expect(attr(runProps(shape, 'gone'), 'strike')).toBe('sngStrike');
        const link = runProps(shape, 'link');
        expect(attr(link, 'u')).toBe('sng');
        // canvas-text.css draws a link in its text's color, black on a black box.
        expect(srgb(link).val).toBe(srgb(runProps(shape, 'plain ')).val);
        const rId = String(xmlAttr(first(link, A, 'hlinkClick'), R, 'id'));
        expect(relationships(zip, 'ppt/slides/slide1.xml').get(rId)).toEqual({
            type: `${R}/hyperlink`,
            target: 'https://example.com/?a=1&b=%222%22',
            mode: 'External',
        });
        // canvas-text.css's `p + p` margin, 0.5em of 48 px: 12 pt.
        const [firstPPr, secondPPr] = descendants(shape, A, 'pPr');
        expect(descendants(firstPPr, A, 'spcBef')).toHaveLength(0);
        expect(attr(first(first(secondPPr, A, 'lnSpc'), A, 'spcPts'), 'val')).toBe('2880');
        expect(attr(first(first(secondPPr, A, 'spcBef'), A, 'spcPts'), 'val')).toBe('1200');
        // The empty paragraph keeps its size, so its line has a height.
        const empty = descendants(shape, A, 'p')[2];
        expect(attr(first(empty, A, 'endParaRPr'), 'sz')).toBe('2400');
    });

    test('a link target percent-encodes what a URI cannot hold', () => {
        const zip = pptx(
            sceneOf([
                element('richtext', {
                    html: '<p><a href="https://a.b/x yé?q=50%">web</a> <a href="mailto:jé@x.nl?subject=hi there">mail</a></p>',
                }),
            ]),
        );
        const shape = only(zip);
        const rels = relationships(zip, 'ppt/slides/slide1.xml');
        const target = (text: string) =>
            rels.get(String(xmlAttr(first(runProps(shape, text), A, 'hlinkClick'), R, 'id')));
        expect(target('web')?.target).toBe('https://a.b/x%20y%C3%A9?q=50%');
        expect(target('mail')?.target).toBe('mailto:j%C3%A9@x.nl?subject=hi%20there');
    });

    test('a script or file link a peer writes never reaches a relationship', () => {
        const zip = pptx(
            sceneOf([
                element('richtext', {
                    html: '<p><a href="javascript:alert(1)">js</a> <a href=" JaVaScRiPt:alert(1)">mixed</a> <a href="file:///etc/passwd">file</a></p>',
                }),
            ]),
        );
        expect(paragraphs(only(zip))).toEqual(['js mixed file']);
        expect(descendants(only(zip), A, 'hlinkClick')).toHaveLength(0);
        expect([...relationships(zip, 'ppt/slides/slide1.xml').values()].map((rel) => rel.type)).toEqual([
            `${R}/slideLayout`,
        ]);
    });

    test("a paragraph's leading break keeps its line, its last one draws none", () => {
        const html = '<p><br>after<br></p><p> x <br></p><p>foo<br> </p><p>bar<br>\n</p>';
        const shape = only(pptx(sceneOf([element('richtext', { html })])));
        expect(paragraphs(shape)).toEqual(['\nafter', 'x', 'foo', 'bar']);
    });

    test('lists by nesting level: bullets and numbers', () => {
        const shape = only(
            pptx(
                sceneOf([
                    element('richtext', {
                        html: '<ul><li><p>one</p><ul><li><p>nested</p></li></ul></li></ul><ol><li><p>first</p></li></ol>',
                    }),
                ]),
            ),
        );
        expect(paragraphs(shape)).toEqual(['one', 'nested', 'first']);
        const [one, nested, numbered] = descendants(shape, A, 'pPr');
        expect(attr(one, 'lvl')).toBeUndefined();
        expect(attr(first(one, A, 'buChar'), 'char')).toBe('•');
        expect(attr(nested, 'lvl')).toBe('1');
        expect(Number(attr(nested, 'marL'))).toBe(2 * Number(attr(one, 'marL')));
        expect(attr(first(numbered, A, 'buAutoNum'), 'type')).toBe('arabicPeriod');
    });

    test('a tall line and a deep list stop at the schema ceilings', () => {
        const nested = `${'<ul><li><p>deep</p>'.repeat(20)}${'</li></ul>'.repeat(20)}`;
        const shape = only(pptx(sceneOf([element('richtext', { html: nested, fontSize: 400, lineHeight: 10 })])));
        // 10 × 400 px is 2000 pt, past ST_TextSpacingPoint's 1584 pt.
        expect(attr(first(first(shape, A, 'lnSpc'), A, 'spcPts'), 'val')).toBe('158400');
        // Twenty levels of 1.5em at 400 px, past ST_TextMargin's 51,206,400 EMU.
        const margins = descendants(shape, A, 'pPr').map((pPr) => Number(attr(pPr, 'marL')));
        expect(margins.at(-1)).toBe(51_206_400);
        expect(Math.max(...margins)).toBe(51_206_400);
    });

    test('a quote indents past its bar and draws at 70%', () => {
        const shape = only(
            pptx(sceneOf([element('richtext', { html: '<blockquote><p>quoted</p></blockquote><p>after</p>' })])),
        );
        const [quoted, after] = descendants(shape, A, 'pPr');
        // 0.75em of 48 px and the 3 px bar.
        expect(attr(quoted, 'marL')).toBe(String(39 * EMU));
        expect(attr(after, 'marL')).toBeUndefined();
        expect(srgb(runProps(shape, 'quoted')).alpha).toBe(70000);
        expect(srgb(runProps(shape, 'after')).alpha).toBeUndefined();
    });

    test('hostile strings reach the XML escaped, control characters dropped', () => {
        const hostile = 'a < b & "c" ]]> \u0001￾ d';
        const scene = sceneOf(
            [
                element('richtext', {
                    html: `<p>${hostile.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')}</p>`,
                }),
                element('arrow', { index: 'a1', points: '[[0,0],[100,0]]', height: 0, text: hostile }),
            ],
            [{ id: 'f1', index: 'a0', name: hostile }],
        );
        const zip = pptx(scene);
        const [box, , , label] = shapes(zip);
        const clean = 'a < b & "c" ]]>  d';
        // HTML collapses the two spaces the dropped characters leave.
        expect(paragraphs(box)).toEqual(['a < b & "c" ]]> d']);
        expect(paragraphs(label)).toEqual([clean]);
        expect(attr(first(part(zip, 'ppt/slides/slide1.xml'), P, 'cSld'), 'name')).toBe(clean);
    });
});

describe('pptx images and backgrounds', () => {
    const square = { width: 200, height: 200, mediaName: 'wide.png' };

    test('cover crops the source, contain fits the extents, fill stretches', () => {
        const zip = pptx(
            sceneOf([
                element('image', { ...square, index: 'a0', objectFit: 'cover', corners: 'straight' }),
                element('image', { ...square, index: 'a1', objectFit: 'contain', corners: 'straight' }),
                element('image', { ...square, index: 'a2', objectFit: 'fill', corners: 'round', opacity: 40 }),
            ]),
            [PNG_MEDIA],
        );
        const [cover, contain, fill] = shapes(zip);
        expect(cover.local).toBe('pic');
        // A 4:1 picture in a square keeps its middle quarter.
        const crop = first(cover, A, 'srcRect');
        expect([attr(crop, 'l'), attr(crop, 'r'), attr(crop, 't'), attr(crop, 'b')]).toEqual([
            '37500',
            '37500',
            undefined,
            undefined,
        ]);
        expect(xfrm(contain)).toEqual({ x: 100 * EMU, y: 125 * EMU, cx: 200 * EMU, cy: 50 * EMU, rot: 0 });
        expect(descendants(contain, A, 'srcRect')).toHaveLength(0);
        expect(geometry(fill)).toBe('roundRect');
        expect(attr(first(fill, A, 'alphaModFix'), 'amt')).toBe('40000');
        // One media part, three references.
        const rels = relationships(zip, 'ppt/slides/slide1.xml');
        const embeds = descendants(first(part(zip, 'ppt/slides/slide1.xml'), P, 'spTree'), A, 'blip').map((blip) =>
            rels.get(String(xmlAttr(blip, R, 'embed'))),
        );
        expect(new Set(embeds.map((rel) => rel?.target))).toEqual(new Set(['../media/image1.png']));
    });

    test('an SVG goes in beside its PNG, a picture with no media writes nothing', () => {
        const svg: OfficeMedia = {
            name: 'd.svg',
            contentType: 'image/svg+xml',
            data: toTransferableText('<svg xmlns="http://www.w3.org/2000/svg"/>'),
            png: toTransferableText('png'),
            width: 10,
            height: 10,
        };
        const zip = pptx(
            sceneOf([
                element('image', { index: 'a0', mediaName: 'd.svg' }),
                element('image', { index: 'a1', mediaName: 'gone.png', strokeColor: 'transparent' }),
            ]),
            [svg],
        );
        const pic = only(zip);
        expect(descendants(pic, ASVG, 'svgBlip')).toHaveLength(1);
        expect(zip.names().filter((n) => n.startsWith('ppt/media/'))).toEqual([
            'ppt/media/image1.png',
            'ppt/media/image1.svg',
        ]);
    });

    test('a frame background: solid, gradient, image', () => {
        const zip = pptx(
            sceneOf(
                [],
                [
                    { id: 'f1', index: 'a0', background: { type: 'solid', color: '#ff000080' } },
                    {
                        id: 'f2',
                        index: 'a1',
                        background: { type: 'gradient', from: '#ffffff', to: '#000000', angle: 135 },
                    },
                    { id: 'f3', index: 'a2', background: { type: 'image', mediaName: 'wide.png', fit: 'cover' } },
                    { id: 'f4', index: 'a3', background: null },
                    { id: 'f5', index: 'a4', background: { type: 'image', mediaName: 'wide.png', fit: 'contain' } },
                ],
            ),
            [PNG_MEDIA],
        );
        const bg = (n: number) => descendants(part(zip, `ppt/slides/slide${n}.xml`), P, 'bgPr')[0];
        expect(srgb(first(bg(1), A, 'solidFill'))).toEqual({ val: 'FF0000', alpha: 50196 });
        // A background is CSS's linear-gradient, at its own angle on any slide.
        expect(attr(first(bg(2), A, 'lin'), 'ang')).toBe('2700000');
        // A 4:1 picture covering a 16:9 slide reaches 4 / (16 / 9) − 1 = 125% past it, half each side.
        const cover = first(first(bg(3), A, 'blipFill'), A, 'fillRect');
        expect([attr(cover, 'l'), attr(cover, 'r'), attr(cover, 't')]).toEqual(['-62500', '-62500', undefined]);
        // Contained, it leaves (1 − 16 / 9 / 4) / 2 of the slide's height empty above and below.
        const contain = first(first(bg(5), A, 'blipFill'), A, 'fillRect');
        expect([attr(contain, 't'), attr(contain, 'b'), attr(contain, 'l')]).toEqual(['27778', '27778', undefined]);
        expect(bg(4)).toBeUndefined();
    });
});
