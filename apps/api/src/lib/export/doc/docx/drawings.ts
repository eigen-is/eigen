import type { JSONContent } from '@tiptap/core';
import { parseChartSpec, readChartLook } from '@workspace/lib/charts';
import { chartSvg, readChartAttrs, readFigureAttrs } from '@workspace/lib/docs/eigendoc';
import { escapeXml } from '@workspace/lib/xml';
import { BODY, boxSide, cssPt, twips } from '../../../document/looks';
import { sanitizeMedia } from '../../../document/media';
import { proseValue } from '../../../document/prose-css';
import { type ExportMedia, toTransferableBuffer, toTransferableText } from '../../../document/transform/protocol';
import { EMU_PER_PX, PIC_NS, R_NS } from '../../../ooxml/ooxml';
import { BORDER_SIDES, EMU_PER_TWIP, TWIPS_PER_PX } from '../../../ooxml/wordml';
import { splitDataUri } from '../../../shared/data-uri';
import { blipXml, encodeOfficeImage, officeImageParts } from '../../office-image';
import { useFace } from './fonts';
import type { Context, Package } from './package';
import { type Block, type Inset, indentOf, type Paragraph, paragraphXml, quoteBar, styleSpacing } from './paragraphs';
import { textXml } from './runs';
import { TABLE_BORDER_SIDES } from './tables';

// Figures: the thumbnail Worker's PNG or JPEG, an SVG beside its PNG fallback.

// The media item a figure draws in a docx: its media file, else a pasted data: src, which the transform process encodes
// under that src, as it draws a chart under its size, look and spec. A media name holds no `/`, so no two keys meet.
function figureMediaKey(node: JSONContent): string | null {
    if (node.type === 'chart') {
        const attrs = node.attrs ?? {};
        const { spec, width, height } = readChartAttrs(attrs);
        return `chart/${width}/${height}/${JSON.stringify(readChartLook(attrs))}/${spec}`;
    }
    const { mediaName, src } = readFigureAttrs(node.attrs ?? {});
    return mediaName ?? (src && splitDataUri(src) ? src : null);
}

// A chart has no media file either: it draws as the SVG the HTML export inlines, through the sanitizer a pasted SVG
// takes. A spec that doesn't parse draws nothing, so its caption stands alone.
export async function chartFigureMedia(roots: JSONContent[]): Promise<ExportMedia[]> {
    const charts = new Map<string, string>();
    const visit = (node: JSONContent) => {
        const key = node.type === 'chart' ? figureMediaKey(node) : null;
        if (key && !charts.has(key)) {
            const attrs = readChartAttrs(node.attrs ?? {});
            const spec = parseChartSpec(attrs.spec ?? '');
            if (spec) charts.set(key, chartSvg(spec, attrs));
        }
        for (const child of node.content ?? []) visit(child);
    };
    for (const root of roots) visit(root);
    if (charts.size === 0) return [];
    const { sanitizeExportMedia } = await import('../../sanitize');
    return sanitizeExportMedia(
        Array.from(charts, ([name, svg]) => ({ name, contentType: 'image/svg+xml', data: toTransferableText(svg) })),
    );
}

// A figure pasted with a data: src has no media file, and the main thread never reads the doc, so each src is decoded
// here, once, through the encode a media file takes; an SVG through the sanitizer the main thread's media took.
export async function pastedFigureMedia(roots: JSONContent[]): Promise<ExportMedia[]> {
    const pasted = new Map<string, { mediaType: string | null; base64: string }>();
    const visit = (node: JSONContent) => {
        if (node.type === 'figure') {
            const key = figureMediaKey(node);
            if (key && key === node.attrs?.['src']) {
                const split = splitDataUri(key);
                if (split) pasted.set(key, split);
            }
        }
        for (const child of node.content ?? []) visit(child);
    };
    for (const root of roots) visit(root);
    if (pasted.size === 0) return [];
    const { sharpResize } = await import('../../../shared/sharp-resize');
    const media: ExportMedia[] = [];
    for (const [src, { mediaType, base64 }] of pasted) {
        const data = Buffer.from(base64, 'base64');
        if (mediaType === 'image/svg+xml') {
            media.push({ name: src, contentType: mediaType, data: toTransferableBuffer(data) });
            continue;
        }
        const item = await encodeOfficeImage(src, mediaType ?? '', data, (options) => sharpResize(data, options));
        if (item) media.push(item);
    }
    return sanitizeMedia(media);
}

// One image file per media name, and one relationship per part that shows it; an SVG's PNG is its blip, the SVG its
// extension.
export type ImageFile = { part: string; svgPart?: string; width: number; height: number };

export type Image = ImageFile & { rId: string; svgRId?: string };

// Missing media, an external src (a docx fetches nothing) and media without a size or fallback write only the caption.
export function figureOf(node: JSONContent, context: Context): Block[] {
    const attrs = readFigureAttrs(node.attrs ?? {});
    const { layout, alignment, caption, width, alt } = attrs;
    const side = layout === 'wrap-left' ? 'left' : layout === 'wrap-right' ? 'right' : undefined;
    const jc = side ? 'center' : (alignment ?? 'center');
    const captionRuns = caption ? textXml(caption) : '';
    if (captionRuns) useFace(context.pkg, {}, 'Caption');
    const margin = proseValue('.eigen-prose .figure', 'margin');
    const top = twips(cssPt(boxSide(margin, 'top'), BODY.sizePt));
    const bottom = twips(cssPt(boxSide(margin, 'bottom'), BODY.sizePt));
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
    const key = figureMediaKey(node);
    const image = key ? imageOf(key, context.pkg) : undefined;
    // The caption alone is the figure's box, as the HTML's.
    if (!image) return captionRuns ? [captionParagraph(0, { top: top + captionBefore, bottom })] : [];
    const columnPx = Math.floor((context.column - context.indent) / TWIPS_PER_PX);
    const set = Math.round(width ?? 0);
    const natural = Math.min(image.width, side ? Math.floor(columnPx / 2) : columnPx);
    const cx = Math.max(1, Math.round(set > 0 ? Math.min(set, columnPx) : natural)) * EMU_PER_PX;
    const drawing = drawingXml(
        image,
        cx,
        // Observed in Word: a fractional-twip height refits the width (a 1204×4 px divider drew 466.5 pt wide), so the height is whole.
        Math.max(EMU_PER_TWIP, Math.round((cx * image.height) / image.width / EMU_PER_TWIP) * EMU_PER_TWIP),
        // A chart's is the one its HTML gives its image.
        node.type === 'chart'
            ? parseChartSpec(readChartAttrs(node.attrs ?? {}).spec ?? '')?.title || 'Chart'
            : (alt ?? ''),
        context.pkg,
    );
    if (!side) {
        // Single, or LibreOffice adds 5 pt above every image.
        const spacing = { before: 0, after: 0, line: 240 };
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
    const tw = cx / EMU_PER_TWIP;
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
        paragraphXml({ props: { spacing: { before: 0, after: 0, line: 240 }, jc: 'center' }, runs: drawing }),
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

// The first figure to show a media name adds its files, and the first in each part that part's relationships; no
// positive size, an SVG without PNG or another type adds none.
function imageOf(name: string, pkg: Package): Image | undefined {
    const known = pkg.part.images.get(name);
    if (known) return known;
    let file = pkg.imageFiles.get(name);
    if (!file) {
        const media = pkg.media.get(name);
        const { width, height } = media ?? {};
        if (!media || !isPositive(width) || !isPositive(height)) return undefined;
        const parts = officeImageParts(media, pkg.imageFiles.size + 1);
        if (!parts) return undefined;
        file = { part: parts.part, ...(parts.svgPart && { svgPart: parts.svgPart }), width, height };
        pkg.files.push([`word/media/${parts.part}`, parts.raster]);
        if (parts.svgPart) pkg.files.push([`word/media/${parts.svgPart}`, media.data]);
        pkg.imageFiles.set(name, file);
    }
    const relate = (target: string) =>
        `rId${pkg.part.relationships.push({ type: `${R_NS}/image`, target: `media/${target}` })}`;
    const image: Image = { ...file, rId: relate(file.part), ...(file.svgPart && { svgRId: relate(file.svgPart) }) };
    pkg.part.images.set(name, image);
    return image;
}

function isPositive(value: number | undefined): value is number {
    return value !== undefined && Number.isFinite(value) && value > 0;
}

// Word and LibreOffice draw the svgBlip; a reader without SVG draws the PNG.
function drawingXml(image: Image, cx: number, cy: number, alt: string, pkg: Package): string {
    const n = ++pkg.drawings;
    const descr = escapeXml(alt);
    const blip = blipXml(image.rId, image.svgRId);
    return [
        `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`,
        `<wp:docPr id="${n}" name="Picture ${n}" descr="${descr}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`,
        `<a:graphic><a:graphicData uri="${PIC_NS}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="${image.part}" descr="${descr}"/><pic:cNvPicPr/></pic:nvPicPr>`,
        `<pic:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`,
    ].join('');
}
