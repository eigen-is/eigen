import { describe, expect, test } from 'bun:test';
import { sampleChartSpec } from '@workspace/lib/charts';
import type { BackgroundFill } from '@workspace/lib/types/background';
import {
    baseDefaultsFor,
    convertToShapes,
    ELEMENT_KINDS,
    FRAME_FIELDS,
    readVectorFromDoc,
    SLIDES_STYLE_DEFAULTS,
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
import type { DocxMedia } from '../../lib/export/doc/to-docx';
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

function deckDoc(frames: FrameSpec[], elements: Fields[]): Y.Doc {
    const doc = new Y.Doc();
    doc.transact(() => {
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
function sceneOf(elements: Fields[], frames: FrameSpec[] = [{ id: 'f1', index: 'a0' }]): VectorScene {
    return sanitizeSceneHtml(readVectorFromDoc(deckDoc(frames, elements)));
}

function pptx(scene: VectorScene, media: DocxMedia[] = []): ZipReader {
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

const PNG_MEDIA: DocxMedia = {
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

    test('the slide size comes from the frame: 16:9 and 4:3', () => {
        const wide = pptx(sceneOf([element('rectangle', { corners: 'straight' })]));
        const wideSize = first(part(wide, 'ppt/presentation.xml'), P, 'sldSz');
        expect([attr(wideSize, 'cx'), attr(wideSize, 'cy')]).toEqual(['12192000', '6858000']);
        expect(xfrm(only(wide))).toEqual({ x: 100 * EMU, y: 50 * EMU, cx: 200 * EMU, cy: 100 * EMU, rot: 0 });

        const scene = sceneOf([element('rectangle', { corners: 'straight', x: 192, y: 144 })]);
        const square = pptx({ ...scene, frames: scene.frames.map((frame) => ({ ...frame, height: 1440 })) });
        const squareSize = first(part(square, 'ppt/presentation.xml'), P, 'sldSz');
        expect([attr(squareSize, 'cx'), attr(squareSize, 'cy')]).toEqual(['9144000', '6858000']);
        // 4,762.5 EMU per px, rounded to whole EMU.
        expect(xfrm(only(square))).toEqual({ x: 914400, y: 685800, cx: 952500, cy: 476250, rot: 0 });
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

    test('an arrow label is a centered text box at the label anchor', () => {
        const [, label] = shapes(
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
        const rId = String(xmlAttr(first(link, A, 'hlinkClick'), R, 'id'));
        expect(relationships(zip, 'ppt/slides/slide1.xml').get(rId)).toEqual({
            type: `${R}/hyperlink`,
            target: 'https://example.com/?a=1&b="2"',
            mode: 'External',
        });
        // The empty paragraph keeps its size, so its line has a height.
        const empty = descendants(shape, A, 'p')[2];
        expect(attr(first(empty, A, 'endParaRPr'), 'sz')).toBe('2400');
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
        const [box, , label] = shapes(zip);
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
        const svg: DocxMedia = {
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
                        background: { type: 'gradient', from: '#ffffff', to: '#000000', angle: 90 },
                    },
                    { id: 'f3', index: 'a2', background: { type: 'image', mediaName: 'wide.png', fit: 'cover' } },
                    { id: 'f4', index: 'a3', background: null },
                ],
            ),
            [PNG_MEDIA],
        );
        const bg = (n: number) => descendants(part(zip, `ppt/slides/slide${n}.xml`), P, 'bgPr')[0];
        expect(srgb(first(bg(1), A, 'solidFill'))).toEqual({ val: 'FF0000', alpha: 50196 });
        expect(attr(first(bg(2), A, 'lin'), 'ang')).toBe('0');
        const blip = first(bg(3), A, 'blipFill');
        // A 4:1 picture on a 16:9 slide keeps the middle 16:9 of it.
        expect(attr(first(blip, A, 'srcRect'), 'l')).toBe('27778');
        expect(bg(4)).toBeUndefined();
    });
});
