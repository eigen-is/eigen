// A text box as Word's own: a wps shape holding its paragraphs, in front of or behind the text at its offsets, wrapped
// on one side, or in its own line. The paragraph walker calls anchoredTextBox or inlineTextBox for each box it meets.
// The shape sits in mc:AlternateContent with no VML fallback, as Word for the web writes one, and its fill, outline,
// insets, vertical alignment and rounded corners are the box's. A box whose text may run past its height grows, as it
// does in Eigen.

import type { JSONContent } from '@tiptap/core';
import { CHART_DEFAULT_SIZE } from '@workspace/lib/charts';
import { DOCUMENT_LINE_RATIO, readFontSize } from '@workspace/lib/constants/fonts';
import type { TextBoxAttrs } from '@workspace/lib/docs/eigendoc';
import {
    flattenNestedStories,
    isPositioned,
    ptToPx,
    readChartAttrs,
    readFigureAttrs,
    readTextBoxAttrs,
    TEXT_BOX_RADIUS,
    textBoxPadding,
} from '@workspace/lib/docs/eigendoc';
import { CHARACTER_WIDTH_EM, FIGURE_MARGIN } from '../../../document/looks';
import { ANCHOR_BY_ALIGN, BORDER_DASH_BY_STYLE, solidFillXml } from '../../../ooxml/drawingml';
import { pxToEmu, WPS_NS } from '../../../ooxml/ooxml';
import { SINGLE_LINE, TWIPS_PER_PX } from '../../../ooxml/wordml';
import { figureMediaKey } from '../pasted-media';
import type { Placement } from './drawings';
import { drawingHead, positionedPlacement, wrapGap } from './drawings';
import type { Context, Package } from './package';
import type { Paragraph } from './paragraphs';
import { blocksOf, blocksXml, indentOf, quoteBar } from './paragraphs';

// The anchor run a box in front of or behind the text, or wrapped beside it, opens its paragraph with.
export function anchoredTextBox(node: JSONContent, textblock: JSONContent, context: Context): string {
    const attrs = readTextBoxAttrs(node.attrs ?? {});
    if (isPositioned(attrs.layout)) {
        return textBoxRun(node, attrs, context, positionedPlacement(attrs, textblock, context));
    }
    const side = attrs.layout === 'wrap-right' ? 'right' : 'left';
    return textBoxRun(node, attrs, context, { side, fromText: wrapGap(side, (pt) => pxToEmu(ptToPx(pt))) });
}

// A box in the flow: a paragraph of its own, aligned as the box is, with a figure's margin as its inset.
export function inlineTextBox(node: JSONContent, context: Context): Paragraph {
    const attrs = readTextBoxAttrs(node.attrs ?? {});
    return {
        props: {
            pBdr: quoteBar(undefined, context),
            spacing: { before: 0, after: 0, line: SINGLE_LINE },
            ind: indentOf(undefined, context),
            jc: attrs.alignment ?? 'center',
        },
        runs: textBoxRun(node, attrs, context),
        inset: { top: FIGURE_MARGIN.top, bottom: FIGURE_MARGIN.bottom },
    };
}

function textBoxRun(node: JSONContent, attrs: TextBoxAttrs, context: Context, placement?: Placement): string {
    const { pkg } = context;
    const n = ++pkg.lastDrawingId;
    const padding = textBoxPadding(attrs);
    const pen = attrs.outline === 'none' ? null : attrs.outline;
    const penWidth = pen?.width ?? 0;
    // The box's text column in px, inside its padding and its pen.
    const column = Math.max(1, attrs.width - 2 * padding.x - 2 * penWidth);
    // The box's paragraphs, in its column, with no space between them, as a cell's.
    const inside: Context = {
        pkg,
        firstInFlow: false,
        column: Math.max(1, Math.round(column * TWIPS_PER_PX)),
        indent: 0,
        depth: 0,
        orderedListsAround: 0,
        quotes: 0,
        after: 0,
    };
    // A forged note or box inside is its text, since Word refuses a note reference or a shape in a box.
    const story = flattenNestedStories(node);
    const content = blocksXml(blocksOf(story.content ?? [], {}, inside), pkg.styles);
    // Word clips a box at a fixed height and refits one that fits its text, so a box whose text may run past its
    // height grows: the larger of the two is its extent, and Word refits it on layout.
    const estimate = contentHeight(story, column, pkg) + 2 * padding.y + 2 * penWidth;
    const holds = attrs.height !== null && attrs.height >= estimate;
    const cx = pxToEmu(attrs.width);
    const cy = pxToEmu(Math.max(attrs.height ?? 0, estimate));
    // Word's roundRect radius is a share of the shorter side, in 100000ths of it, at most half. Eigen draws a fixed
    // radius.
    const roundness = Math.round(Math.min(50000, (pxToEmu(TEXT_BOX_RADIUS) / Math.min(cx, cy)) * 100000));
    const geometry = attrs.rounded
        ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${roundness}"/></a:avLst></a:prstGeom>`
        : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
    const fill = attrs.fill ? solidFillXml(attrs.fill) : '<a:noFill/>';
    const dash = pen && BORDER_DASH_BY_STYLE[pen.style];
    const line = pen
        ? `<a:ln w="${pxToEmu(pen.width)}"${pen.style === 'double' ? ' cmpd="dbl"' : ''}>${solidFillXml(pen.color)}${dash ? `<a:prstDash val="${dash}"/>` : ''}</a:ln>`
        : '<a:ln><a:noFill/></a:ln>';
    // The box's middle is DrawingML's center.
    const anchor = ANCHOR_BY_ALIGN[attrs.verticalAlign === 'middle' ? 'center' : (attrs.verticalAlign ?? 'top')];
    const bodyPr = `<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="${pxToEmu(padding.x)}" tIns="${pxToEmu(padding.y)}" rIns="${pxToEmu(padding.x)}" bIns="${pxToEmu(padding.y)}" anchor="${anchor}" anchorCtr="0">${holds ? '<a:noAutofit/>' : '<a:spAutoFit/>'}</wps:bodyPr>`;
    const { head, frame } = drawingHead(n, cx, cy, placement);
    const shape = [
        `<a:graphic><a:graphicData uri="${WPS_NS}"><wps:wsp><wps:cNvSpPr txBox="1"/>`,
        `<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>${geometry}${fill}${line}</wps:spPr>`,
        `<wps:txbx><w:txbxContent>${content}</w:txbxContent></wps:txbx>${bodyPr}</wps:wsp></a:graphicData></a:graphic>`,
    ].join('');
    return [
        '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>',
        `${head}<wp:docPr id="${n}" name="Text Box ${n}"/><wp:cNvGraphicFramePr/>${shape}</${frame}>`,
        '</w:drawing></mc:Choice></mc:AlternateContent></w:r>',
    ].join('');
}

// The height the box's content takes in its text column of `column` px: each paragraph's characters at its largest
// run's size and the Normal's line, and its pictures and charts as tall as the writer draws them in that column.
function contentHeight(node: JSONContent, column: number, pkg: Package): number {
    const { size: normal, lineSpacing } = pkg.normal;
    let height = 0;
    for (const paragraph of node.content ?? []) {
        const size = Math.max(normal, largestRun(paragraph));
        const perLine = Math.max(1, Math.floor(column / (ptToPx(size) * CHARACTER_WIDTH_EM.normal)));
        const count = characters(paragraph);
        const figures = figuresHeight(paragraph, column, pkg);
        // A paragraph that holds only a picture is the picture's height; an empty one is still a line.
        const lines = count > 0 || figures === 0 ? Math.max(1, Math.ceil(count / perLine)) : 0;
        height += lines * ptToPx(size * lineSpacing * DOCUMENT_LINE_RATIO) + figures;
    }
    return height;
}

// The largest size a run in the node sets, in pt; 0 when none sets one.
function largestRun(node: JSONContent): number {
    const own = (node.marks ?? []).map((mark) =>
        mark.type === 'textStyle' ? (readFontSize(mark.attrs?.['fontSize']) ?? 0) : 0,
    );
    return Math.max(0, ...own, ...(node.content ?? []).map(largestRun));
}

// How tall the node's pictures and charts draw, at most the column wide and at their stored or own ratio, as the
// drawing writer sizes them. A picture with no media to draw adds nothing, as the writer drops it.
function figuresHeight(node: JSONContent, column: number, pkg: Package): number {
    if (node.type === 'chart') {
        const { width, height } = readChartAttrs(node.attrs ?? {});
        const natural = width ?? CHART_DEFAULT_SIZE.width;
        return (Math.min(natural, column) * (height ?? CHART_DEFAULT_SIZE.height)) / natural;
    }
    if (node.type === 'figure') {
        const attrs = readFigureAttrs(node.attrs ?? {});
        const media = pkg.images.media.get(figureMediaKey(attrs) ?? '');
        if (!media?.width || !media.height) return 0;
        const ratio = attrs.height && attrs.width ? attrs.height / attrs.width : media.height / media.width;
        return Math.min(attrs.width ?? media.width, column) * ratio;
    }
    return (node.content ?? []).reduce((sum, child) => sum + figuresHeight(child, column, pkg), 0);
}

function characters(node: JSONContent): number {
    if (node.type === 'text') return node.text?.length ?? 0;
    return (node.content ?? []).reduce((sum, child) => sum + characters(child), 0);
}
