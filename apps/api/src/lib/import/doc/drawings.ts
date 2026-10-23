import type { JSONContent } from '@tiptap/core';
import { CHART_DEFAULT_SIZE, CHART_MAX_SIDE, isFigureFrameNode, pageTwips, ptToPx } from '@workspace/lib/docs/eigendoc';
import {
    A_NS,
    ASVG_NS,
    C_NS,
    DGM_NS,
    DSP_NS,
    EMU_PER_PX,
    isOn,
    O_NS,
    PIC_NS,
    POINTS_PER_UNIT,
    R_NS,
    V_NS,
    W_NS,
    WP_NS,
} from '../../core/ooxml';
import { CHART_NOT_IMPORTED, chartCost, chartPart, droppedChart, readChart } from '../../core/ooxml-chart';
import { hasXmlName, type XmlElement, xmlAttr, xmlChild, xmlChildren, xmlElements, xmlText } from '../../core/xml';
import { EMU_PER_TWIP, FLOATING_WRAPS } from '../../document/wordml';
import { IMAGE_EXTENSION_BY_MIME, MIME_ALIASES } from '../image-types';
import { type Item, inlineText, isCaptionLike, isFigureOnly, type Para, paraOf } from './assemble';
import { descendants, int } from './package';
import { type Reader, readBlocks, type Scope } from './paragraphs';
import { pushText, type RunContext } from './runs';

// A part the package gives no type takes its extension's, and a misspelt type its alias; both only through the
// allowlist, so a part declared as anything else is still never stored. A WMF or EMF figure shows its alt text in a
// broken image, and an export leaves it out.
const MIME_BY_EXTENSION = new Map([
    ...[...IMAGE_EXTENSION_BY_MIME].map(([mime, extension]): [string, string] => [extension, mime]),
    ['jpg', 'image/jpeg'],
]);

function imageType(reader: Reader, path: string): string | undefined {
    const declared = reader.pkg.contentTypeOf(path);
    if (declared) return MIME_ALIASES.get(declared) ?? declared;
    return MIME_BY_EXTENSION.get(path.slice(path.lastIndexOf('.') + 1).toLowerCase());
}

// sharp has no loader for these, so no screen preview shows them.
export const UNSHOWN_IMAGE_TYPES = new Set(['image/bmp', 'image/x-wmf', 'image/x-emf']);

export type MediaPart = { name: string; path: string; contentType: string };

// One media file per image part, named by encounter order.
function mediaName(reader: Reader, path: string): string | undefined {
    const known = reader.imageNames.get(path);
    if (known) return known;
    const contentType = imageType(reader, path);
    const extension = contentType && IMAGE_EXTENSION_BY_MIME.get(contentType);
    if (!contentType || !extension || !reader.pkg.zip.entry(path)) return undefined;
    const name = `image-${reader.images.length + 1}.${extension}`;
    reader.images.push({ name, path, contentType });
    reader.imageNames.set(path, name);
    return name;
}

function partPath(id: string | undefined, scope: Scope): string | undefined {
    const rel = id ? scope.part.rels.get(id) : undefined;
    return rel && !rel.external ? rel.target : undefined;
}

function widthPx(px: number, columnPx: number): number {
    return Math.min(columnPx, Math.max(1, Math.round(px)));
}

export function readDrawing(reader: Reader, drawing: XmlElement, context: RunContext): void {
    for (const frame of xmlElements(drawing)) {
        if (frame.ns !== WP_NS) continue;
        const anchored = frame.local === 'anchor';
        // A band holds no floating picture: a header's logo would cover the page's body. One behind the text, a full-page
        // letterhead or a watermark, it drops, as a block it would push the body off the page.
        const inBand = context.scope.story === 'band';
        if (anchored && inBand && isOn(frame.attributes['behindDoc'])) {
            reader.bandDropped++;
            continue;
        }
        const layout = anchored ? anchorLayout(frame, reader, inBand) : {};
        const docPr = xmlChild(frame, WP_NS, 'docPr');
        const alt = docPr?.attributes['descr'] || docPr?.attributes['title'] || null;
        const extent = xmlChild(frame, WP_NS, 'extent');
        const pictures = descendants(frame, PIC_NS, 'pic');
        const figures: JSONContent[] = [];
        for (const picture of pictures) {
            const [blip] = descendants(picture, A_NS, 'blip');
            const [svg] = blip ? descendants(blip, ASVG_NS, 'svgBlip') : [];
            const embedded = (element: XmlElement | undefined) => element && xmlAttr(element, R_NS, 'embed');
            const path = partPath(embedded(svg), context.scope) ?? partPath(embedded(blip), context.scope);
            const name = path && mediaName(reader, path);
            if (!name) {
                // A linked picture lives outside the file; its alt text says what it was.
                if (blip && !embedded(blip) && xmlAttr(blip, R_NS, 'link') && alt) pushText(reader, alt, {}, context);
                continue;
            }
            const ext = pictures.length === 1 ? extent : descendants(picture, A_NS, 'ext')[0];
            const cx = int(ext?.attributes['cx']);
            const width = cx ? widthPx(cx / EMU_PER_PX, reader.columnPx) : null;
            figures.push({ type: 'figure', attrs: { mediaName: name, alt, width, ...layout } });
            if (anchored && inBand) reader.bandAnchors++;
        }
        // Only the body holds a chart: a band's schema has none and a note's Insert leaves it out, so there it keeps its
        // title, read with SmartArt's text.
        if (context.scope.story === 'body')
            for (const [reference, ext] of chartsIn(frame, extent)) {
                const chart = readDocxChart(reader, reference, context.scope);
                if ('spec' in chart) {
                    figures.push({
                        type: 'chart',
                        attrs: { spec: chart.spec, ...chartSize(ext, reader.columnPx), ...layout },
                    });
                    continue;
                }
                reader.chartsDropped++;
                context.pending.push(
                    paraOf(
                        chart.dropped.flatMap((text, index) => [
                            ...(index > 0 ? [{ type: 'hardBreak' }] : []),
                            { type: 'text', text },
                        ]),
                    ),
                );
            }
        // A shape's text boxes: the caption of a grouped picture, a picture with its caption, or text that follows.
        const boxed = descendants(frame, W_NS, 'txbxContent').flatMap((box) =>
            readBlocks(reader, xmlElements(box), onShape(context.scope)),
        );
        const content = boxed.filter((item) => item.kind !== 'para' || !item.empty);
        const paras = content.filter((item): item is Para => item.kind === 'para');
        const [head, ...tail] = paras;
        const inner = head && isFigureOnly(head) ? head.inlines.filter((node) => isFigureFrameNode(node.type)) : [];
        const [boxedFigure] = inner;
        const onlyParas = paras.length > 0 && paras.length === content.length;
        if (onlyParas && figures.length === 1 && paras.every(isCaptionLike)) {
            const [figure] = figures;
            if (figure?.attrs) figure.attrs['caption'] = paras.map((para) => inlineText(para.inlines)).join('\n');
        } else if (
            onlyParas &&
            figures.length === 0 &&
            boxedFigure &&
            inner.length === 1 &&
            tail.every(isCaptionLike)
        ) {
            const caption =
                tail.map((para) => inlineText(para.inlines)).join('\n') || boxedFigure.attrs?.['caption'] || null;
            figures.push({ ...boxedFigure, attrs: { ...boxedFigure.attrs, ...layout, caption } });
        } else for (const item of boxed) context.pending.push(item);
        for (const figure of figures) context.pieces.push({ kind: 'node', node: figure });
        for (const item of graphicText(reader, frame, context.scope)) context.pending.push(item);
    }
}

// SmartArt's text is the document's: its drawing's shapes in order, else its data model's points; the schema holds no
// SmartArt, so each counts as dropped. A chart outside the body keeps its title only.
function graphicText(reader: Reader, frame: XmlElement, scope: Scope): Item[] {
    const lines: JSONContent[][] = [];
    for (const diagram of descendants(frame, DGM_NS, 'relIds')) {
        reader.graphicsDropped++;
        const data = readOnce(reader, partPath(xmlAttr(diagram, R_NS, 'dm'), scope));
        if (!data) continue;
        const [ext] = descendants(data, DSP_NS, 'dataModelExt');
        const drawing = readOnce(reader, partPath(ext?.attributes['relId'], scope));
        const paragraphs = drawing
            ? descendants(drawing, DSP_NS, 'txBody').flatMap((body) => xmlChildren(body, A_NS, 'p'))
            : descendants(data, DGM_NS, 'pt')
                  .filter((point) => SMARTART_TEXT_POINTS.has(point.attributes['type'] ?? 'node'))
                  .flatMap((point) => descendants(point, A_NS, 'p'));
        for (const paragraph of paragraphs) lines.push(drawingLine(paragraph));
    }
    for (const chart of scope.story === 'body' ? [] : descendants(frame, C_NS, 'chart')) {
        reader.chartsDropped++;
        const space = readOnce(reader, partPath(xmlAttr(chart, R_NS, 'id'), scope));
        const plot = space && xmlChild(space, C_NS, 'chart');
        const title = plot && xmlChild(plot, C_NS, 'title');
        const text = title && xmlChild(title, C_NS, 'tx');
        if (!text) continue;
        const rich = xmlChild(text, C_NS, 'rich');
        // A title from a cell keeps the cell's cached text.
        const cached = descendants(text, C_NS, 'v').map(xmlText).join('');
        if (rich) for (const paragraph of xmlChildren(rich, A_NS, 'p')) lines.push(drawingLine(paragraph));
        else if (cached) lines.push([{ type: 'text', text: cached }]);
    }
    return lines.filter((line) => line.some((node) => node.type === 'text')).map(paraOf);
}

// A chart part as the doc holds it: the spec the node stores, or the lines a chart left out leaves in its place.
export type DocxChart = { spec: string } | { dropped: string[] };

// Each chart a drawing shows with the a:ext it is drawn at: alone, the drawing's extent; in a group or a canvas, its own
// graphicFrame's. A text box's content is its own paragraphs', read with them.
function chartsIn(frame: XmlElement, extent: XmlElement | undefined): [XmlElement, XmlElement | undefined][] {
    const charts: [XmlElement, XmlElement | undefined][] = [];
    const stack: [XmlElement, XmlElement | undefined][] = [[frame, extent]];
    for (let next = stack.pop(); next; next = stack.pop()) {
        const [element, ext] = next;
        if (hasXmlName(element, C_NS, 'chart')) charts.push(next);
        else if (!hasXmlName(element, W_NS, 'txbxContent')) {
            const xfrm =
                element.local === 'graphicFrame' && xmlElements(element).find((child) => child.local === 'xfrm');
            const own = xfrm ? xmlChild(xfrm, A_NS, 'ext') : ext;
            for (const child of xmlElements(element).reverse()) stack.push([child, own]);
        }
    }
    return charts;
}

// The chart a c:chart names, read once per part: its spec, or the words for a chart the reader can't draw, a part
// missing, damaged or of another type, or one past the chart allowance, as Slides leaves a box for each.
function readDocxChart(reader: Reader, reference: XmlElement, scope: Scope): DocxChart {
    const { readPart, contentTypeOf } = reader.pkg;
    const id = xmlAttr(reference, R_NS, 'id');
    const root = chartPart({ part: readPart, contentTypeOf }, scope.part.rels, id, 'word/charts/');
    if (!root) return { dropped: [CHART_NOT_IMPORTED] };
    const known = reader.charts.get(root);
    if (known) return known;
    const read = reader.pkg.spendChart(chartCost(root)) && readChart(root, { theme: reader.colors, data: 'cache' });
    const chart = !read
        ? { dropped: [CHART_NOT_IMPORTED] }
        : 'spec' in read
          ? { spec: JSON.stringify(read.spec) }
          : { dropped: droppedChart(read.unsupported) };
    reader.charts.set(root, chart);
    return chart;
}

// Its drawn size, shrunk to the text column and to the node's largest side, keeping its shape.
function chartSize(ext: XmlElement | undefined, columnPx: number): { width: number; height: number } {
    const cx = int(ext?.attributes['cx']) ?? 0;
    const cy = int(ext?.attributes['cy']) ?? 0;
    const { width, height } =
        cx > 0 && cy > 0 ? { width: cx / EMU_PER_PX, height: cy / EMU_PER_PX } : CHART_DEFAULT_SIZE;
    const scale = Math.min(1, columnPx / width, CHART_MAX_SIDE / height);
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// The points a SmartArt draws text for; transitions and presentation points hold none of the document's.
const SMARTART_TEXT_POINTS = new Set(['node', 'asst']);

// A part a second graphic names adds nothing, so no file multiplies one part's text.
function readOnce(reader: Reader, path: string | undefined): XmlElement | undefined {
    if (!path || reader.graphicParts.has(path)) return undefined;
    reader.graphicParts.add(path);
    return reader.pkg.readPart(path);
}

function drawingLine(paragraph: XmlElement): JSONContent[] {
    const line: JSONContent[] = [];
    for (const child of xmlElements(paragraph)) {
        if (child.ns !== A_NS) continue;
        if (child.local === 'br') line.push({ type: 'hardBreak' });
        const run = (child.local === 'r' || child.local === 'fld') && xmlChild(child, A_NS, 't');
        const text = run && xmlText(run).replace(/[\r\n]/g, ' ');
        if (text) line.push({ type: 'text', text });
    }
    return line;
}

export function readVml(reader: Reader, element: XmlElement, context: RunContext): void {
    for (const shape of xmlElements(element)) {
        if (shape.ns !== V_NS) {
            if (shape.ns !== W_NS || shape.local !== 'control') readVml(reader, shape, context);
            continue;
        }
        if (xmlAttr(shape, O_NS, 'hr') === 't') {
            context.pieces.push({ kind: 'hr' });
            continue;
        }
        // A band's VML text is Word's text watermark, its text a path no node holds; a shapetype only defines one.
        const textPath = descendants(shape, V_NS, 'textpath').some((path) => path.attributes['string']);
        if (context.scope.story === 'band' && shape.local !== 'shapetype' && textPath) reader.bandDropped++;
        for (const data of descendants(shape, V_NS, 'imagedata')) {
            // A band's VML picture is Word's picture watermark, laid over the page.
            if (context.scope.story === 'band') {
                reader.bandDropped++;
                continue;
            }
            const path = partPath(xmlAttr(data, R_NS, 'id') ?? xmlAttr(data, O_NS, 'relid'), context.scope);
            const name = path && mediaName(reader, path);
            if (!name) continue;
            const width = vmlWidthPx(shape.attributes['style'] ?? '', reader.columnPx);
            const alt = shape.attributes['alt'] || xmlAttr(data, O_NS, 'title') || null;
            context.pieces.push({ kind: 'node', node: { type: 'figure', attrs: { mediaName: name, alt, width } } });
        }
        for (const box of descendants(shape, W_NS, 'txbxContent'))
            for (const item of readBlocks(reader, xmlElements(box), onShape(context.scope))) context.pending.push(item);
    }
}

// A shape's text sits on its fill, which the schema drops.
function onShape(scope: Scope): Scope {
    return { ...scope, onFill: true };
}

// Wrapped beside the text, on the side its alignment or its offset puts it; otherwise, or as a block, aligned if Word
// aligns it.
function anchorLayout(anchor: XmlElement, reader: Reader, block: boolean): Record<string, string> {
    const wrapped = xmlElements(anchor).some((child) => child.ns === WP_NS && FLOATING_WRAPS.has(child.local));
    const positionH = xmlChild(anchor, WP_NS, 'positionH');
    const align = positionH && xmlChild(positionH, WP_NS, 'align');
    const offset = positionH && xmlChild(positionH, WP_NS, 'posOffset');
    const cx = int(xmlChild(anchor, WP_NS, 'extent')?.attributes['cx']) ?? 0;
    const side = align
        ? xmlText(align).trim()
        : offset &&
            columnOffset(reader, positionH.attributes['relativeFrom'], int(xmlText(offset)) ?? 0, cx) + cx / 2 >
                reader.columnTwips * EMU_PER_TWIP * 0.5
          ? 'right'
          : 'left';
    if (wrapped && !block) return { layout: side === 'right' || side === 'outside' ? 'wrap-right' : 'wrap-left' };
    return side === 'left' || side === 'right' || side === 'center' ? { alignment: side } : {};
}

// An offset from the area relativeFrom names, from the text column's left edge, kept on the paper: the page and the
// left or inside margin start at the paper's edge, the right or outside margin at the column's end, and the margin, the
// column and a character at the column, a character's place in its line being unknown.
function columnOffset(reader: Reader, relativeFrom: string | undefined, offset: number, cx: number): number {
    const { width, margin } = pageTwips(reader.page);
    const marginLeft = margin.left * EMU_PER_TWIP;
    const area = AREA_AT_PAPER_EDGE.has(relativeFrom ?? '')
        ? -marginLeft
        : AREA_AT_COLUMN_END.has(relativeFrom ?? '')
          ? reader.columnTwips * EMU_PER_TWIP
          : 0;
    return Math.min(Math.max(area + offset, -marginLeft), width * EMU_PER_TWIP - marginLeft - cx);
}

const AREA_AT_PAPER_EDGE = new Set(['page', 'leftMargin', 'insideMargin']);
const AREA_AT_COLUMN_END = new Set(['rightMargin', 'outsideMargin']);

const PX_PER_UNIT = new Map([
    ['px', 1],
    ...[...POINTS_PER_UNIT].map(([unit, points]): [string, number] => [unit, ptToPx(points)]),
]);

const VML_WIDTH = new RegExp(`(?:^|;)\\s*width\\s*:\\s*([\\d.]+)(${[...PX_PER_UNIT.keys()].join('|')})?`, 'i');

function vmlWidthPx(style: string, columnPx: number): number | null {
    const match = style.match(VML_WIDTH);
    if (!match) return null;
    const px = Number(match[1]) * (PX_PER_UNIT.get((match[2] ?? 'px').toLowerCase()) ?? 1);
    return Number.isFinite(px) && px > 0 ? widthPx(px, columnPx) : null;
}
