import type { JSONContent } from '@tiptap/core';
import { type XmlElement, xmlAttr, xmlChild, xmlElements, xmlText } from '../../core/xml';
import { A_NS, ASVG_NS, EMU_PER_PX, EMU_PER_TWIP, O_NS, PIC_NS, R_NS, V_NS, W_NS, WP_NS } from '../../export/doc/ooxml';
import { COLUMN_PX, isCaptionLike, isFigureOnly, type Para, textOf } from './assemble';
import { contentTypeOf, descendants, int } from './package';
import { type Reader, readBlocks, type Scope } from './paragraphs';
import { linkOf, pushText, type RunContext } from './runs';

// The image types a part may be stored as, each under its own extension. WMF and EMF are kept though no browser or
// sharp draws them: the figure shows its alt text in a broken image, and an export leaves it out.
export const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/tiff': 'tiff',
    'image/bmp': 'bmp',
    'image/x-wmf': 'wmf',
    'image/x-emf': 'emf',
};

// A part the package gives no type takes its extension's, and image/jpg is a common misspelling; both only through
// the allowlist, so a part declared as anything else is still never stored.
const MIME_BY_EXTENSION = new Map([
    ...Object.entries(IMAGE_EXTENSION_BY_MIME).map(([mime, extension]): [string, string] => [extension, mime]),
    ['jpg', 'image/jpeg'],
]);
const MIME_ALIASES: Record<string, string> = { 'image/jpg': 'image/jpeg' };

function imageType(reader: Reader, path: string): string | undefined {
    const declared = contentTypeOf(reader.pkg, path);
    if (declared) return MIME_ALIASES[declared] ?? declared;
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
    const extension = contentType && IMAGE_EXTENSION_BY_MIME[contentType];
    if (!contentType || !extension || !reader.pkg.zip.entry(path)) return undefined;
    const name = `image-${reader.images.length}.${extension}`;
    reader.images.push({ name, path, contentType });
    reader.imageNames.set(path, name);
    return name;
}

function imagePath(id: string | undefined, scope: Scope): string | undefined {
    const rel = id ? scope.part.rels.get(id) : undefined;
    return rel && !rel.external ? rel.target : undefined;
}

function widthPx(px: number): number {
    return Math.min(COLUMN_PX, Math.max(1, Math.round(px)));
}

export function readDrawing(reader: Reader, drawing: XmlElement, context: RunContext): void {
    for (const frame of xmlElements(drawing)) {
        if (frame.ns !== WP_NS) continue;
        const layout = frame.local === 'anchor' ? anchorLayout(frame, reader.columnTwips * EMU_PER_TWIP) : {};
        const docPr = xmlChild(frame, WP_NS, 'docPr');
        const alt = docPr?.attributes['descr'] || docPr?.attributes['title'] || null;
        const extent = xmlChild(frame, WP_NS, 'extent');
        const pictures = descendants(frame, PIC_NS, 'pic');
        const figures: JSONContent[] = [];
        for (const picture of pictures) {
            const [blip] = descendants(picture, A_NS, 'blip');
            const [svg] = blip ? descendants(blip, ASVG_NS, 'svgBlip') : [];
            const embedded = (element: XmlElement | undefined) => element && xmlAttr(element, R_NS, 'embed');
            const path = imagePath(embedded(svg), context.scope) ?? imagePath(embedded(blip), context.scope);
            const name = path && mediaName(reader, path);
            if (!name) {
                // A linked picture lives outside the file; its alt text says what it was.
                if (blip && !embedded(blip) && xmlAttr(blip, R_NS, 'link') && alt) pushText(reader, alt, {}, context);
                continue;
            }
            const ext = pictures.length === 1 ? extent : descendants(picture, A_NS, 'ext')[0];
            const cx = int(ext?.attributes['cx']);
            const width = cx ? widthPx(cx / EMU_PER_PX) : null;
            figures.push({ type: 'figure', attrs: { mediaName: name, alt, width, ...layout } });
        }
        // A shape's text boxes: the caption of a grouped picture, a picture with its caption, or text that follows.
        const boxed = descendants(frame, W_NS, 'txbxContent').flatMap((box) =>
            readBlocks(reader, xmlElements(box), context.scope),
        );
        const content = boxed.filter((item) => item.kind !== 'para' || !item.empty);
        const paras = content.filter((item): item is Para => item.kind === 'para');
        const [head, ...tail] = paras;
        const inner = head && isFigureOnly(head) ? head.inlines.filter((node) => node.type === 'figure') : [];
        const [boxedFigure] = inner;
        const onlyParas = paras.length > 0 && paras.length === content.length;
        if (onlyParas && figures.length === 1 && paras.every(isCaptionLike)) {
            const [figure] = figures;
            if (figure?.attrs) figure.attrs['caption'] = paras.map((para) => textOf(para.inlines)).join('\n');
        } else if (
            onlyParas &&
            figures.length === 0 &&
            boxedFigure &&
            inner.length === 1 &&
            tail.every(isCaptionLike)
        ) {
            const caption =
                tail.map((para) => textOf(para.inlines)).join('\n') || boxedFigure.attrs?.['caption'] || null;
            figures.push({ ...boxedFigure, attrs: { ...boxedFigure.attrs, ...layout, caption } });
        } else for (const item of boxed) context.pending.push(item);
        // A picture's own link, DrawingML's click hyperlink on its frame.
        const click = docPr && xmlChild(docPr, A_NS, 'hlinkClick');
        const link = click ? linkOf(reader, click, context.scope) : undefined;
        for (const figure of figures) pushFigure(figure, link ? { ...context, link } : context);
    }
}

// A linked image keeps its link.
function pushFigure(figure: JSONContent, context: RunContext): void {
    const { link } = context;
    const node = link
        ? { ...figure, marks: [{ type: 'link', attrs: { href: link.href, title: link.title } }] }
        : figure;
    context.pieces.push({ kind: 'node', node });
}

export function readVml(reader: Reader, element: XmlElement, context: RunContext): void {
    for (const shape of xmlElements(element)) {
        if (shape.ns !== V_NS) {
            if (shape.ns !== W_NS || shape.local !== 'control') readVml(reader, shape, context);
            continue;
        }
        if (shape.attributes['o:hr'] === 't' || xmlAttr(shape, O_NS, 'hr') === 't') {
            context.pieces.push({ kind: 'hr' });
            continue;
        }
        for (const data of descendants(shape, V_NS, 'imagedata')) {
            const path = imagePath(xmlAttr(data, R_NS, 'id') ?? xmlAttr(data, O_NS, 'relid'), context.scope);
            const name = path && mediaName(reader, path);
            if (!name) continue;
            const width = vmlWidthPx(shape.attributes['style'] ?? '');
            const alt = shape.attributes['alt'] || data.attributes['o:title'] || null;
            pushFigure({ type: 'figure', attrs: { mediaName: name, alt, width } }, context);
        }
        for (const box of descendants(shape, W_NS, 'txbxContent'))
            for (const item of readBlocks(reader, xmlElements(box), context.scope)) context.pending.push(item);
    }
}

// Wrapped beside the text, on the side its alignment or its offset puts it; otherwise a block, aligned if Word aligns it.
function anchorLayout(anchor: XmlElement, columnEmu: number): Record<string, string> {
    const wrapped = xmlElements(anchor).some(
        (child) => child.ns === WP_NS && ['wrapSquare', 'wrapTight', 'wrapThrough'].includes(child.local),
    );
    const positionH = xmlChild(anchor, WP_NS, 'positionH');
    const align = positionH && xmlChild(positionH, WP_NS, 'align');
    const offset = positionH && xmlChild(positionH, WP_NS, 'posOffset');
    const cx = int(xmlChild(anchor, WP_NS, 'extent')?.attributes['cx']) ?? 0;
    const side = align
        ? xmlText(align).trim()
        : offset && (int(xmlText(offset)) ?? 0) + cx / 2 > columnEmu / 2
          ? 'right'
          : 'left';
    if (wrapped) return { layout: side === 'right' || side === 'outside' ? 'wrap-right' : 'wrap-left' };
    return side === 'left' || side === 'right' || side === 'center' ? { alignment: side } : {};
}

const PX_PER_UNIT: Record<string, number> = { px: 1, pt: 4 / 3, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 };

function vmlWidthPx(style: string): number | null {
    const match = style.match(/(?:^|;)\s*width\s*:\s*([\d.]+)(pt|px|in|cm|mm)?/i);
    if (!match) return null;
    const px = Number(match[1]) * (PX_PER_UNIT[(match[2] ?? 'px').toLowerCase()] ?? 1);
    return Number.isFinite(px) && px > 0 ? widthPx(px) : null;
}
