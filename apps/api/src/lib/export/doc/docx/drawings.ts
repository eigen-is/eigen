// Figures: the thumbnail Worker's PNG or JPEG, an SVG beside its PNG fallback, and charts, each a Word chart. A block
// figure is a paragraph of its own and a wrapped one a floating table. One in front of or behind the text is an anchor
// in the paragraph that holds it. The paragraph walker calls figureOf or anchoredFigure for each figure it meets.

import type { JSONContent } from '@tiptap/core';
import { CHART_DEFAULT_SIZE, readChartSpec } from '@workspace/lib/charts';
import { readChartAttrs, readFigureAttrs, readFigureFrameAttrs } from '@workspace/lib/docs/eigendoc';
import { escapeXml } from '@workspace/lib/xml';
import { anchorIndentPx, anchorPaddingPx, BODY, boxSide, cssPt, FIGURE_MARGIN, twips } from '../../../document/looks';
import { proseValue } from '../../../document/prose-css';
import { blipXml } from '../../../ooxml/drawingml';
import { EMU_PER_PX, PIC_NS } from '../../../ooxml/ooxml';
import { chartGraphicXml } from '../../../ooxml/ooxml-chart-writer';
import { BORDER_SIDES, EMU_PER_TWIP, SINGLE_LINE, TWIPS_PER_PX } from '../../../ooxml/wordml';
import { addOfficeChart } from '../../office-chart';
import type { OfficeImage } from '../../office-image';
import { figureMediaKey } from '../pasted-media';
import { useFace } from './fonts';
import type { Context, Package } from './package';
import type { Block, Inset, Paragraph } from './paragraphs';
import { indentOf, paragraphXml, quoteBar, styleSpacing } from './paragraphs';
import { textXml } from './runs';
import { TABLE_BORDER_SIDES } from './tables';

// One image file per media name, and one relationship per part that shows it; an SVG's PNG is its blip, the SVG its
// extension.
type Image = OfficeImage & { kind: 'picture'; width: number; height: number; rId: string; svgRId?: string };

// A chart part of its own per chart node, related from the part that shows it.
type WordChart = { kind: 'chart'; width: number; height: number; rId: string; alt: string };

// What a drawing shows, at its extent in EMU.
type Drawn = { image: Image | WordChart; cx: number; cy: number; alt: string };

// Where an anchored drawing sits, in EMU from the text column and from the top of its paragraph's first line.
type Placement = { x: number; y: number; behind: boolean };

// Word stacks anchors by relativeHeight. Eigen draws each layer in document order, and the drawing ids follow it.
const RELATIVE_HEIGHT = 251658240;

// Missing media, an external src (a docx fetches nothing) and media without a size or fallback write only the caption.
export function figureOf(node: JSONContent, context: Context): Block[] {
    const { layout, alignment, caption } = readFigureAttrs(node.attrs ?? {});
    const side = layout === 'wrap-left' ? 'left' : layout === 'wrap-right' ? 'right' : undefined;
    const jc = side ? 'center' : (alignment ?? 'center');
    const captionRuns = caption ? textXml(caption) : '';
    if (captionRuns) useFace(context.pkg, {}, 'Caption');
    const { top, bottom } = FIGURE_MARGIN;
    const captionBefore = styleSpacing(context.pkg.styles, 'Caption', 'before');
    const captionParagraph = (before: number, inset: Inset): Paragraph => ({
        props: {
            style: 'Caption',
            pBdr: quoteBar('Caption', context),
            spacing: { before, after: 0 },
            ind: indentOf('Caption', context),
            jc,
        },
        runs: `<w:r>${captionRuns}</w:r>`,
        inset,
    });
    const columnPx = Math.floor((context.column - context.indent) / TWIPS_PER_PX);
    const drawn = drawnFigure(node, context.pkg, columnPx, side ? Math.floor(columnPx / 2) : columnPx);
    // The caption alone is the figure's box, as the HTML's.
    if (!drawn) return captionRuns ? [captionParagraph(0, { top: top + captionBefore, bottom })] : [];
    const drawing = drawingXml(drawn, context.pkg);
    if (!side) {
        // Single, or LibreOffice adds 5 pt above every image.
        const spacing = { before: 0, after: 0, line: SINGLE_LINE };
        // The caption takes the figure's margin below.
        const inset = { top, bottom: captionRuns ? 0 : bottom };
        // A note's every paragraph is Footnote Text, its image's too.
        const props = {
            ...(context.style === 'FootnoteText' && { style: context.style }),
            pBdr: quoteBar(undefined, context),
            spacing,
            ind: indentOf(undefined, context),
            jc,
        };
        const figure: Block[] = [{ props, runs: drawing, inset }];
        if (captionRuns) figure.push(captionParagraph(captionBefore, { top: 0, bottom }));
        return figure;
    }
    // A borderless floating one-cell table, the one wrap that keeps the caption under the image in every reader.
    const float = proseValue(`.eigen-prose .figure[data-layout="wrap-${side}"]`, 'margin');
    const fromText = (edge: 'top' | 'right' | 'bottom' | 'left') => twips(cssPt(boxSide(float, edge), BODY.sizePt));
    const tw = drawn.cx / EMU_PER_TWIP;
    const nil = TABLE_BORDER_SIDES.map((edge) => `<w:${edge} w:val="nil"/>`).join('');
    const unpadded = BORDER_SIDES.map((edge) => `<w:${edge} w:w="0" w:type="dxa"/>`).join('');
    // A list or quote indents only the left, so a right float keeps the margin's edge.
    const x = side === 'left' && context.indent > 0 ? `w:tblpX="${context.indent}"` : `w:tblpXSpec="${side}"`;
    const tblPr = [
        `<w:tblpPr w:leftFromText="${fromText('left')}" w:rightFromText="${fromText('right')}" w:topFromText="${fromText('top')}" w:bottomFromText="${fromText('bottom')}" w:vertAnchor="text" w:horzAnchor="margin" ${x} w:tblpY="1"/>`,
        '<w:tblOverlap w:val="never"/>',
        `<w:tblW w:w="${tw}" w:type="dxa"/>`,
        `<w:tblBorders>${nil}</w:tblBorders>`,
        '<w:tblLayout w:type="fixed"/>',
        `<w:tblCellMar>${unpadded}</w:tblCellMar>`,
    ].join('');
    const cell = [
        paragraphXml({ props: { spacing: { before: 0, after: 0, line: SINGLE_LINE }, jc: 'center' }, runs: drawing }),
        captionRuns &&
            paragraphXml({
                props: {
                    style: 'Caption',
                    spacing: { before: captionBefore, after: 0 },
                    jc: 'center',
                },
                runs: `<w:r>${captionRuns}</w:r>`,
            }),
    ].join('');
    // Unsplit, or Google Docs moves the caption to the next page.
    const row = `<w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:tcW w:w="${tw}" w:type="dxa"/></w:tcPr>${cell}</w:tc></w:tr>`;
    return [
        {
            table: `<w:tbl><w:tblPr>${tblPr}</w:tblPr><w:tblGrid><w:gridCol w:w="${tw}"/></w:tblGrid>${row}</w:tbl>`,
            float: true,
        },
    ];
}

// A figure in front of or behind the text: an anchor run in the paragraph that holds it, placed from the text column
// and from the paragraph's first line. Eigen places it from the paragraph's padding box, so its indents go into X and
// the padding above its text into Y. The line, not the paragraph: LibreOffice counts a paragraph's offset from the end
// of the space after the block above, so the place would move with how a reader spaces the two paragraphs. A picture it
// can't write writes nothing.
export function anchoredFigure(node: JSONContent, textblock: JSONContent, context: Context): string {
    const { pkg } = context;
    const { layout, offsetX, offsetY } = readFigureFrameAttrs(node.attrs ?? {});
    const paperPx = Math.floor(pkg.paper / TWIPS_PER_PX);
    const drawn = drawnFigure(node, pkg, paperPx, paperPx);
    if (!drawn) return '';
    // A numbered paragraph's own indent isn't in the file, so it isn't in X either, as the reader reads it back.
    const x = (offsetX ?? 0) + anchorIndentPx(context.indent, context.numbered ? undefined : textblock);
    const y = (offsetY ?? 0) - anchorPaddingPx(textblock, context.depth > 0 || context.quotes > 0, pkg.normal);
    return drawingXml(drawn, pkg, {
        x: Math.round(x * EMU_PER_PX),
        y: Math.round(y * EMU_PER_PX),
        behind: layout === 'behind',
    });
}

// The picture or chart a figure draws: as wide as its width up to `cap` px, else its natural width up to `room`. A
// figure that names a picture it can't write is counted; one that names none loses nothing.
function drawnFigure(node: JSONContent, pkg: Package, cap: number, room: number): Drawn | undefined {
    const attrs = readFigureAttrs(node.attrs ?? {});
    const set = Math.round(attrs.width ?? 0);
    // The EMU a figure of this natural width is drawn across.
    const extent = (natural: number) =>
        Math.max(1, Math.round(set > 0 ? Math.min(set, cap) : Math.min(natural, room))) * EMU_PER_PX;
    const image = node.type === 'chart' ? wordChartOf(node, pkg, extent) : imageOf(figureMediaKey(attrs), pkg);
    if (!image && node.type !== 'chart' && (attrs.mediaName || attrs.src)) pkg.lost('images-dropped');
    if (!image) return undefined;
    const cx = extent(image.width);
    return {
        image,
        cx,
        // Observed in Word: a fractional-twip height refits the width (a 1204×4 px divider drew 466.5 pt wide), so the height is whole.
        cy: Math.max(EMU_PER_TWIP, Math.round((cx * image.height) / image.width / EMU_PER_TWIP) * EMU_PER_TWIP),
        alt: image.kind === 'chart' ? image.alt : (attrs.alt ?? ''),
    };
}

// The first figure to show a media name adds its files, and the first in each part that part's relationships; no
// positive size, an SVG without PNG or another type adds none, nor does a figure without media.
function imageOf(name: string | null, pkg: Package): Image | undefined {
    if (!name) return undefined;
    const { width, height } = pkg.images.media.get(name) ?? {};
    if (!isPositive(width) || !isPositive(height)) return undefined;
    const image = pkg.images.image(name);
    if (!image) return undefined;
    const relate = (target: string) => pkg.partRels.relate('image', `media/${target}`);
    return {
        ...image,
        kind: 'picture',
        width,
        height,
        rId: relate(image.part),
        ...(image.svgPart && { svgRId: relate(image.svgPart) }),
    };
}

// The chart at the scale `extent` draws it at. A chart addOfficeChart leaves out draws nothing, and its caption stands
// alone. Word draws the labels in the spec's font, so that font is embedded as a run's is, and its bold for the title.
function wordChartOf(node: JSONContent, pkg: Package, extent: (natural: number) => number): WordChart | undefined {
    const attrs = readChartAttrs(node.attrs ?? {});
    const { spec } = readChartSpec(node.attrs ?? {});
    const width = attrs.width ?? CHART_DEFAULT_SIZE.width;
    const height = attrs.height ?? CHART_DEFAULT_SIZE.height;
    const frame = { width, height, emuPerPx: extent(width) / width };
    const rId = addOfficeChart(
        pkg.charts,
        spec,
        { look: attrs, frame },
        { target: 'charts/', relate: pkg.partRels.relate, lost: pkg.lost },
    );
    // addOfficeChart relates no part without a spec, so `!spec` only narrows its type.
    if (!spec || !rId) return undefined;
    const font = spec.chart.fontFamily;
    useFace(pkg, { font }, undefined);
    if (spec.title.text) useFace(pkg, { font, bold: true }, undefined);
    return { kind: 'chart', width, height, rId, alt: spec.title.text || 'Chart' };
}

function isPositive(value: number | undefined): value is number {
    return value !== undefined && Number.isFinite(value) && value > 0;
}

// Word and LibreOffice draw the svgBlip; a reader without SVG draws the PNG. An anchor writes its children in the
// schema's order, as Word reports one out of order as unreadable content.
function drawingXml({ image, cx, cy, alt }: Drawn, pkg: Package, placement?: Placement): string {
    const n = ++pkg.lastDrawingId;
    const descr = escapeXml(alt);
    const frame = placement ? 'wp:anchor' : 'wp:inline';
    const distances = 'distT="0" distB="0" distL="0" distR="0"';
    const opening = placement
        ? [
              `<wp:anchor ${distances} simplePos="0" relativeHeight="${RELATIVE_HEIGHT + n}" behindDoc="${placement.behind ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1">`,
              '<wp:simplePos x="0" y="0"/>',
              `<wp:positionH relativeFrom="column"><wp:posOffset>${placement.x}</wp:posOffset></wp:positionH>`,
              `<wp:positionV relativeFrom="line"><wp:posOffset>${placement.y}</wp:posOffset></wp:positionV>`,
          ].join('')
        : `<wp:inline ${distances}>`;
    const head = `${opening}<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>${placement ? '<wp:wrapNone/>' : ''}`;
    if (image.kind === 'chart') {
        return [
            `<w:r><w:drawing>${head}<wp:docPr id="${n}" name="Chart ${n}" descr="${descr}"/>`,
            `<wp:cNvGraphicFramePr/>${chartGraphicXml(image.rId)}</${frame}></w:drawing></w:r>`,
        ].join('');
    }
    const blip = blipXml(image.rId, image.svgRId);
    return [
        `<w:r><w:drawing>${head}`,
        `<wp:docPr id="${n}" name="Picture ${n}" descr="${descr}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`,
        `<a:graphic><a:graphicData uri="${PIC_NS}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="${image.part}" descr="${descr}"/><pic:cNvPicPr/></pic:nvPicPr>`,
        `<pic:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></${frame}></w:drawing></w:r>`,
    ].join('');
}
