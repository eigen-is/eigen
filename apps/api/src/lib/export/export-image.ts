// The pictures an export embeds: the JPEG or PNG made from a raster source for the PDF and the Office formats, and for
// the docx, pptx and xlsx writers the PNG an SVG falls back to and the media parts of one package.

import { ptToPx } from '@workspace/lib/docs/eigendoc';
import type { ExportMedia } from '../document/transform/protocol';
import { toTransferableBuffer } from '../document/transform/protocol';
import { IMAGE_EXTENSION_BY_MIME } from '../ooxml/drawingml';
import type { ZipWriteEntry } from '../ooxml/zip';
import { THUMBNAIL_TIMEOUT_SECONDS } from '../shared/thumbnail-timeout';
import type { ImageResult, WorkerInput } from '../shared/thumbnail-worker';

// An image in a docx, pptx or xlsx: the media item, and for an SVG the PNG a reader without SVG draws. The PNG is drawn and
// read inside the transform process, so it never crosses the boundary on ExportMedia.
export type OfficeMedia = ExportMedia & { png?: ArrayBuffer };

// An exported picture's largest side: the raster made from a source, and the PNG an SVG falls back to.
export const EXPORT_IMAGE_MAX_SIZE = 2560;

// The part extension of each type encodeExportImage writes, which an Office package embeds as is.
const RASTER_TYPES = new Set(['image/png', 'image/jpeg']);
const RASTER_EXTENSIONS = new Map(
    [...IMAGE_EXTENSION_BY_MIME].filter(([contentType]) => RASTER_TYPES.has(contentType)),
);

// The [Content_Types].xml Defaults of an Office image's parts: its raster, and an SVG's own beside its PNG.
export const OFFICE_IMAGE_CONTENT_TYPES: Record<string, string> = {
    ...Object.fromEntries([...RASTER_EXTENSIONS].map(([contentType, extension]) => [extension, contentType])),
    svg: 'image/svg+xml',
};

// Lossless codings: a screenshot's or a chart's, whose text and hard edges take a higher JPEG quality than a photo's.
const LOSSLESS_SOURCES = new Set(['image/png', 'image/gif']);
const LOSSLESS_QUALITY = 90;
const PHOTO_QUALITY = 80;

// How far into a WebP the chunk walk reads.
export const WEBP_SCAN_BYTES = 64 * 1024;

// An exported picture is a JPEG made from its source, or a PNG when the source shows transparency, which JPEG has no
// way to hold. Word and PowerPoint for the web and Google Docs show no WebP, and WeasyPrint embeds a JPEG's bytes as
// they are where it decodes a WebP or PNG and deflates it again: a full-screen screenshot went in as 6.8 MB of PNG
// against 0.8 MB of JPEG. `encode` is sharpResize, in the thumbnail Worker for a media file and in the transform process for a data:
// src; its re-encode drops the EXIF, GPS included. `webp` is the start of a WebP source, at least WEBP_SCAN_BYTES of
// it. The size returned is the picture's as sent, shrunk to fit inside EXPORT_IMAGE_MAX_SIZE.
export async function encodeExportImage(
    name: string,
    mime: string,
    webp: Buffer | null,
    encode: (options: WorkerInput['options']) => Promise<ImageResult | null>,
): Promise<ExportMedia | null> {
    let lossless = LOSSLESS_SOURCES.has(mime);
    // A WebP's image chunk names its coding, which the thumbnail Worker doesn't report: VP8L is lossless; VP8 is lossy.
    // An ICC profile, EXIF or alpha puts a VP8X header and other chunks first, so the walk reads past them.
    const head = mime === 'image/webp' ? webp : null;
    for (let at = 12; head && at + 8 <= head.byteLength; ) {
        const chunk = head.toString('latin1', at, at + 4);
        if (chunk === 'VP8L') lossless = true;
        if (chunk === 'VP8L' || chunk === 'VP8 ') break;
        const size = head.readUInt32LE(at + 4);
        at += 8 + size + (size & 1);
    }
    const quality = lossless ? LOSSLESS_QUALITY : PHOTO_QUALITY;
    const encodeAs = (format: 'png' | 'jpeg') =>
        encode({ format, maxSize: EXPORT_IMAGE_MAX_SIZE, quality, fit: 'inside' });
    let format: 'png' | 'jpeg' = 'jpeg';
    let result = await encodeAs(format);
    // A source whose pixels aren't all opaque (a VP8X WebP, an AVIF, a PNG stored as JPEG) takes PNG, which keeps them.
    if (result?.hasAlpha) {
        format = 'png';
        result = await encodeAs(format);
    }
    if (!result) return null;
    return { name, contentType: `image/${format}`, data: toTransferableBuffer(result.data), ...sentSize(result) };
}

// The Worker reports the source's size; sharp shrinks a larger one to fit inside EXPORT_IMAGE_MAX_SIZE, rounding each
// side, and never enlarges a smaller one.
function sentSize({ width, height }: ImageResult): { width: number; height: number } {
    const scale = Math.min(1, EXPORT_IMAGE_MAX_SIZE / Math.max(width, height));
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

// The PNG a reader without SVG draws, from the sanitized XML the svgBlip carries, so both draw one picture. One at a
// time, for one decode's memory; sharp loads only for an SVG.
export async function withSvgFallbacks(media: ExportMedia[]): Promise<OfficeMedia[]> {
    if (!media.some((item) => item.contentType === 'image/svg+xml')) return media;
    const { default: sharp } = await import('sharp');
    const prepared: OfficeMedia[] = [];
    for (const item of media) {
        if (item.contentType !== 'image/svg+xml') {
            prepared.push(item);
            continue;
        }
        try {
            const svg = Buffer.from(item.data);
            const image = sharp(svg);
            const { width = 0, height = 0 } = await image.metadata();
            const png = await image
                .resize(EXPORT_IMAGE_MAX_SIZE, EXPORT_IMAGE_MAX_SIZE, { fit: 'inside', withoutEnlargement: true })
                .png()
                .timeout({ seconds: THUMBNAIL_TIMEOUT_SECONDS })
                .toBuffer();
            prepared.push({ ...item, png: toTransferableBuffer(png), ...cssSize(svg, width, height) });
        } catch {
            // One librsvg can't read, or not in time, leaves the file; a docx keeps its caption.
        }
    }
    return prepared;
}

const PHYSICAL_LENGTH = /^\s*[\d.e+-]+\s*(in|cm|mm|pt|pc)\s*$/i;

// sharp reads an SVG's physical units at 72 dpi and CSS at 96, so a 4in drawing is 288 px to it and 384 in the HTML
// export. Scaled per side, read off the root's start tag; a side the root leaves out follows the other, as sharp
// derives it from the viewBox.
function cssSize(svg: Buffer, width: number, height: number): { width: number; height: number } {
    const root = svg.toString('utf8', 0, svg.indexOf('>') + 1);
    const scale = (value: string | undefined) =>
        value === undefined ? undefined : PHYSICAL_LENGTH.test(value) ? ptToPx(1) : 1;
    const x = scale(root.match(/\swidth="([^"]*)"/)?.[1]);
    const y = scale(root.match(/\sheight="([^"]*)"/)?.[1]);
    return { width: width * (x ?? y ?? 1), height: height * (y ?? x ?? 1) };
}

// An Office image's parts, named by its place among the package's images: the raster every reader draws, and an SVG's
// own file beside its PNG.
export type OfficeImage = { part: string; svgPart?: string; media: OfficeMedia };

// The images one package embeds, by media name. The first use of a name adds its files under `folder`, numbered in that
// order; a type Office can't embed, or an SVG without its PNG, has none.
export type OfficeImages = {
    media: ReadonlyMap<string, OfficeMedia>;
    image(name: string): OfficeImage | undefined;
    files: ZipWriteEntry[];
};

export function officeImages(media: OfficeMedia[], folder: string): OfficeImages {
    const byName = new Map(media.map((item) => [item.name, item]));
    const images = new Map<string, OfficeImage>();
    const files: ZipWriteEntry[] = [];
    return {
        media: byName,
        files,
        image: (name) => {
            const known = images.get(name);
            if (known) return known;
            const item = byName.get(name);
            const svg = item?.contentType === 'image/svg+xml';
            const raster = svg ? item.png : item?.data;
            const extension = svg ? 'png' : item && RASTER_EXTENSIONS.get(item.contentType);
            if (!item || !raster || !extension) return undefined;
            const n = images.size + 1;
            const image: OfficeImage = {
                part: `image${n}.${extension}`,
                ...(svg && { svgPart: `image${n}.svg` }),
                media: item,
            };
            files.push({ name: `${folder}/${image.part}`, data: new Uint8Array(raster), store: true });
            if (image.svgPart)
                files.push({ name: `${folder}/${image.svgPart}`, data: new Uint8Array(item.data), store: true });
            images.set(name, image);
            return image;
        },
    };
}
