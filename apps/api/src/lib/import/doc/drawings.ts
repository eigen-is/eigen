// A docx's drawings as the doc holds them: pictures as figures, placed and sized as Word places them, charts as chart
// nodes through the shared chart reader or the words for one left out, and the text of SmartArt and text boxes. The
// paragraph walk calls it for each w:drawing and VML shape it meets.

import type { JSONContent } from '@tiptap/core';
import { CHART_DEFAULT_SIZE, CHART_MAX_SIDE, newChartSpecParts } from '@workspace/lib/charts';
import type { FigureFrameAttrs } from '@workspace/lib/docs/eigendoc';
import { isFigureFrameNode, mmToPx, pageTwips, ptToPx } from '@workspace/lib/docs/eigendoc';
import type { ChartSpecPartKey } from '@workspace/lib/types/chart';
import type { XmlElement } from '../../core/xml';
import { hasXmlName, xmlAttr, xmlChild, xmlChildren, xmlElements, xmlText } from '../../core/xml';
import { blipEmbeds, diagramDrawingId, diagramTextBodies, IMAGE_MIME_BY_EXTENSION } from '../../ooxml/drawingml';
import {
    A_NS,
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
} from '../../ooxml/ooxml';
import {
    CHART_NOT_IMPORTED,
    chartCost,
    chartPart,
    droppedChart,
    readChart,
    readChartPartLook,
} from '../../ooxml/ooxml-chart';
import { EMU_PER_TWIP, FLOATING_WRAPS } from '../../ooxml/wordml';
import { declaredImageType, IMAGE_TYPES, mediaPart, PICTURE_NOT_IMPORTED } from '../image-types';
import type { Item, ParagraphItem } from './assemble';
import { inlineText, isCaptionLike, isFigureOnly, paraOf } from './assemble';
import { descendants, roundedInt } from './package';
import type { Reader, Scope } from './paragraphs';
import { readBlocks } from './paragraphs';
import type { RunContext } from './runs';

// A chart part as the doc holds it: the parts of the spec the node stores, with the part its look is read from at each
// drawing's size, or the lines a chart left out leaves in its place; and its title, which a band or a note keeps.
export type DocxChart = { title: string } & (
    | { parts: Record<ChartSpecPartKey, string>; root: XmlElement }
    | { dropped: string[] }
);

export function readDrawing(reader: Reader, drawing: XmlElement, context: RunContext): void {
    for (const frame of xmlElements(drawing)) {
        if (frame.ns !== WP_NS) continue;
        const anchored = frame.local === 'anchor';
        // A band holds no floating picture: a header's logo would cover the page's body. One behind the text, a full-page
        // letterhead or a watermark, it drops, as a block it would push the body off the page.
        const inBand = context.scope.story === 'band';
        if (anchored && inBand && isOn(xmlAttr(frame, '', 'behindDoc'))) {
            reader.lost('band-content-dropped');
            continue;
        }
        const extent = xmlChild(frame, WP_NS, 'extent');
        const pictures = descendants(frame, PIC_NS, 'pic');
        const charts = chartsIn(frame, extent);
        const layout = anchored ? anchorPlacement(frame, reader, context) : {};
        // A picture in front of or behind the text may span the paper.
        const room = layout.offsetX === undefined ? reader.columnPx : Math.floor(mmToPx(reader.page.width));
        const docPr = xmlChild(frame, WP_NS, 'docPr');
        const alt = (docPr && (xmlAttr(docPr, '', 'descr') || xmlAttr(docPr, '', 'title'))) || null;
        const figures: JSONContent[] = [];
        for (const picture of pictures) {
            const [blip] = descendants(picture, A_NS, 'blip');
            const [svg, raster] = blipEmbeds(blip);
            const name =
                pictureName(reader, partPath(svg, context.scope)) ??
                pictureName(reader, partPath(raster, context.scope));
            if (!name) {
                // A blip that names nothing is an empty frame. A linked picture, or one embedded from outside the file,
                // lives outside it, so its alt text stays after the line.
                const rels = context.scope.part.rels;
                const outside =
                    [svg, raster].some((id) => id && rels.get(id)?.external) ||
                    (blip && !raster && xmlAttr(blip, R_NS, 'link'));
                if (svg || raster || outside) pictureLeftOut(reader, context, outside ? alt : null);
                continue;
            }
            const ext = pictures.length === 1 ? extent : descendants(picture, A_NS, 'ext')[0];
            const cx = roundedInt(ext && xmlAttr(ext, '', 'cx'));
            const width = cx ? widthPx(cx / EMU_PER_PX, room) : null;
            figures.push({ type: 'figure', attrs: { mediaName: name, alt, width, ...layout } });
            if (anchored && inBand) reader.lost('band-images-unanchored');
        }
        // Only the body holds a chart: a band's schema has none and a note's Insert leaves it out, so there it keeps its
        // title.
        const inBody = context.scope.story === 'body';
        for (const [reference, ext] of charts) {
            const chart = readDocxChart(reader, reference, context.scope);
            if (inBody && 'parts' in chart) {
                const { emuPerPx, ...size } = chartSize(ext, room);
                const look = readChartPartLook(chart.root, { theme: reader.colors, emuPerPx, host: 'docx' });
                figures.push({ type: 'chart', attrs: { ...chart.parts, ...look, ...size, ...layout } });
                continue;
            }
            reader.lost('charts-dropped');
            leaveLines(context, inBody && 'dropped' in chart ? chart.dropped : [chart.title].filter(Boolean));
        }
        // A shape's text boxes: the caption of a grouped picture, a picture with its caption, or text that follows.
        const boxed = descendants(frame, W_NS, 'txbxContent').flatMap((box) =>
            readBlocks(reader, xmlElements(box), onShapeFill(context.scope)),
        );
        const content = boxed.filter((item) => item.kind !== 'para' || !item.empty);
        const paras = content.filter((item): item is ParagraphItem => item.kind === 'para');
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
        const textPath = descendants(shape, V_NS, 'textpath').some((path) => xmlAttr(path, '', 'string'));
        if (context.scope.story === 'band' && shape.local !== 'shapetype' && textPath)
            reader.lost('band-content-dropped');
        for (const data of descendants(shape, V_NS, 'imagedata')) {
            // A band's VML picture is Word's picture watermark, laid over the page.
            if (context.scope.story === 'band') {
                reader.lost('band-content-dropped');
                continue;
            }
            const id = xmlAttr(data, R_NS, 'id') ?? xmlAttr(data, O_NS, 'relid');
            const name = pictureName(reader, partPath(id, context.scope));
            const alt = xmlAttr(shape, '', 'alt') || xmlAttr(data, O_NS, 'title') || null;
            if (!name) {
                // A linked picture lives outside the file, so its alt text stays after the line, as a DrawingML one's.
                if (id) pictureLeftOut(reader, context, context.scope.part.rels.get(id)?.external ? alt : null);
                continue;
            }
            const width = vmlWidthPx(xmlAttr(shape, '', 'style') ?? '', reader.columnPx);
            context.pieces.push({ kind: 'node', node: { type: 'figure', attrs: { mediaName: name, alt, width } } });
        }
        for (const box of descendants(shape, W_NS, 'txbxContent'))
            for (const item of readBlocks(reader, xmlElements(box), onShapeFill(context.scope)))
                context.pending.push(item);
    }
}

// A part the package gives no type takes its extension's, as Word reads one. Only a type of the allowlist is stored.
function imageType(reader: Reader, path: string): string | undefined {
    if (reader.pkg.contentTypeOf(path)) return declaredImageType(reader.pkg, path);
    return IMAGE_MIME_BY_EXTENSION.get(path.slice(path.lastIndexOf('.') + 1).toLowerCase());
}

// One media file per image part, named in encounter order. A part that is missing or of no image type, whose bytes
// don't read, or that is past the pictures' caps has none.
function pictureName(reader: Reader, path: string | undefined): string | undefined {
    const part = path && mediaPart(reader.pkg.zip, path, imageType(reader, path), IMAGE_TYPES);
    return part && reader.files.name(part);
}

// A picture left out is counted and leaves a line saying so, as a slide leaves a box; a linked one, which lives outside
// the file, its alt text after the line.
function pictureLeftOut(reader: Reader, context: RunContext, alt: string | null): void {
    reader.lost('images-dropped');
    leaveLines(context, alt ? [PICTURE_NOT_IMPORTED, alt] : [PICTURE_NOT_IMPORTED]);
}

// What a drawing left out says in its place, a paragraph after the one it stood in, aligned as that one is.
function leaveLines(context: RunContext, lines: string[]): void {
    if (lines.length === 0) return;
    const line = paraOf(
        lines.flatMap((text, index) => [...(index > 0 ? [{ type: 'hardBreak' }] : []), { type: 'text', text }]),
    );
    context.pending.push(line);
    context.leftOut.push(line);
}

function partPath(id: string | undefined, scope: Scope): string | undefined {
    const rel = id ? scope.part.rels.get(id) : undefined;
    return rel && !rel.external ? rel.target : undefined;
}

function widthPx(px: number, columnPx: number): number {
    return Math.min(columnPx, Math.max(1, Math.round(px)));
}

const NOT_IMPORTED: DocxChart = { title: '', dropped: [CHART_NOT_IMPORTED] };

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
    const root = chartPart(reader.pkg, scope.part.rels, xmlAttr(reference, R_NS, 'id'), 'word/charts/');
    if (!root) return NOT_IMPORTED;
    const known = reader.charts.get(root);
    if (known) return known;
    const read = reader.pkg.charts.spend(chartCost(root)) && readChart(root, { theme: reader.colors, data: 'cache' });
    const chart: DocxChart = !read
        ? NOT_IMPORTED
        : 'spec' in read
          ? { title: read.spec.title.text, parts: newChartSpecParts(read.spec), root }
          : { title: read.unsupported.title, dropped: droppedChart(read.unsupported) };
    reader.charts.set(root, chart);
    return chart;
}

// Its drawn size, shrunk to the text column and to the node's largest side, keeping its shape, and the EMU one px of
// that size is drawn at in the file.
function chartSize(ext: XmlElement | undefined, columnPx: number): { width: number; height: number; emuPerPx: number } {
    const cx = roundedInt(ext && xmlAttr(ext, '', 'cx')) ?? 0;
    const cy = roundedInt(ext && xmlAttr(ext, '', 'cy')) ?? 0;
    const drawn = cx > 0 && cy > 0;
    const { width, height } = drawn ? { width: cx / EMU_PER_PX, height: cy / EMU_PER_PX } : CHART_DEFAULT_SIZE;
    const scale = Math.min(1, columnPx / width, CHART_MAX_SIDE / height);
    const size = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
    return { ...size, emuPerPx: drawn ? cx / size.width : EMU_PER_PX };
}

// SmartArt's text is the document's: its drawing's shapes in order, else its data model's points; the schema holds no
// SmartArt, so each counts as dropped.
function graphicText(reader: Reader, frame: XmlElement, scope: Scope): Item[] {
    const lines: JSONContent[][] = [];
    for (const diagram of descendants(frame, DGM_NS, 'relIds')) {
        reader.lost('diagrams-dropped');
        const data = readOnce(reader, partPath(xmlAttr(diagram, R_NS, 'dm'), scope));
        if (!data) continue;
        const drawing = readOnce(reader, partPath(diagramDrawingId(data), scope));
        const bodies = drawing ? descendants(drawing, DSP_NS, 'txBody') : diagramTextBodies(data);
        for (const body of bodies)
            for (const paragraph of xmlChildren(body, A_NS, 'p')) lines.push(drawingLine(paragraph));
    }
    return lines.filter((line) => line.some((node) => node.type === 'text')).map(paraOf);
}

// A part a second graphic names adds nothing, so no file multiplies one part's text.
function readOnce(reader: Reader, path: string | undefined): XmlElement | undefined {
    if (!path || reader.graphicParts.has(path)) return undefined;
    reader.graphicParts.add(path);
    return reader.pkg.part(path);
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

// A shape's text sits on its fill, which the schema drops, and holds no table of contents node.
function onShapeFill(scope: Scope): Scope {
    return { ...scope, onFill: true, inShape: true };
}

// Where Word places an anchor, as the doc holds it. Wrapped beside the text, it sits on the side its alignment or its
// offset puts it. Over or under the text, alone in its anchor and in the body outside a table, it is in front of or
// behind the text, at its offsets from the text column and from the paragraph's first line, which placeAnchors counts
// from the paragraph's box. Any other is a block, aligned if Word aligns it.
function anchorPlacement(anchor: XmlElement, reader: Reader, context: RunContext): FigureFrameAttrs {
    const { story, tables } = context.scope;
    const wrapped = xmlElements(anchor).some((child) => child.ns === WP_NS && FLOATING_WRAPS.has(child.local));
    const positionH = xmlChild(anchor, WP_NS, 'positionH');
    const align = positionH && xmlChild(positionH, WP_NS, 'align');
    const offset = positionH && xmlChild(positionH, WP_NS, 'posOffset');
    const extent = xmlChild(anchor, WP_NS, 'extent');
    const cx = roundedInt(extent && xmlAttr(extent, '', 'cx')) ?? 0;
    const area = areaOf(reader, positionH && xmlAttr(positionH, '', 'relativeFrom'));
    const placed = align ? alignedIn(xmlText(align).trim(), area.width, cx) : roundedInt(offset && xmlText(offset));
    // The offset from the text column's left edge, kept on the paper.
    const { width, margin } = pageTwips(reader.page);
    const marginLeft = margin.left * EMU_PER_TWIP;
    const x = Math.min(Math.max(area.start + (placed ?? 0), -marginLeft), width * EMU_PER_TWIP - marginLeft - cx);
    // One anchor has one place, so only a lone picture or chart can take it. A group's or a canvas's pictures would
    // stack there, and its text boxes and shapes would draw elsewhere.
    const graphic = xmlChild(anchor, A_NS, 'graphic');
    const data = graphic && xmlChild(graphic, A_NS, 'graphicData');
    const [only, ...others] = data ? xmlElements(data) : [];
    const lone = !!only && others.length === 0 && (hasXmlName(only, PIC_NS, 'pic') || hasXmlName(only, C_NS, 'chart'));
    if (xmlChild(anchor, WP_NS, 'wrapNone') && lone && story === 'body' && tables === 0) {
        const layout = isOn(xmlAttr(anchor, '', 'behindDoc')) ? 'behind' : 'front';
        return { layout, offsetX: x / EMU_PER_PX, offsetY: lineOffset(anchor, context) };
    }
    const side = align
        ? xmlText(align).trim()
        : offset && x + cx / 2 > reader.columnTwips * EMU_PER_TWIP * 0.5
          ? 'right'
          : 'left';
    if (wrapped && story !== 'band')
        return { layout: side === 'right' || side === 'outside' ? 'wrap-right' : 'wrap-left' };
    return side === 'left' || side === 'right' || side === 'center' ? { alignment: side } : {};
}

// The area relativeFrom names, in EMU from the text column's left edge: the page and the left or inside margin start at
// the paper's edge, the right or outside margin at the column's end, and the margin, the column and a character at the
// column, a character's place in its line being unknown.
function areaOf(reader: Reader, relativeFrom: string | undefined): { start: number; width: number } {
    const { width, margin } = pageTwips(reader.page);
    const column = reader.columnTwips * EMU_PER_TWIP;
    if (AREA_AT_PAPER_EDGE.has(relativeFrom ?? ''))
        return {
            start: -margin.left * EMU_PER_TWIP,
            width: (relativeFrom === 'page' ? width : margin.left) * EMU_PER_TWIP,
        };
    if (AREA_AT_COLUMN_END.has(relativeFrom ?? '')) return { start: column, width: margin.right * EMU_PER_TWIP };
    return { start: 0, width: column };
}

// Where an alignment puts a picture `cx` wide in an area, from its start.
function alignedIn(align: string, area: number, cx: number): number {
    if (align === 'center') return (area - cx) / 2;
    return align === 'right' || align === 'outside' ? area - cx : 0;
}

// The vertical offset from the paragraph's first line, in px. Word counts one from the paragraph from the top of the
// space before it. One from another area, an aligned one or a simple position has none, so the picture goes to its
// paragraph's top.
function lineOffset(anchor: XmlElement, context: RunContext): number | null {
    const positionV = xmlChild(anchor, WP_NS, 'positionV');
    const offset = positionV && xmlChild(positionV, WP_NS, 'posOffset');
    if (!offset || isOn(xmlAttr(anchor, '', 'simplePos'))) return null;
    const px = (roundedInt(xmlText(offset)) ?? 0) / EMU_PER_PX;
    const relativeFrom = xmlAttr(positionV, '', 'relativeFrom');
    if (relativeFrom === 'line') return px;
    return relativeFrom === 'paragraph' ? px - context.spaceBefore : null;
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
