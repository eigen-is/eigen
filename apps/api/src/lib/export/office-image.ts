// The images the docx, pptx and xlsx writers embed: the WebP a source keeps or the PNG or JPEG it becomes, the PNG an
// SVG falls back to, and the media parts of one package.

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

// An Office image's largest side: the raster the main thread re-encodes and the PNG an SVG falls back to.
export const OFFICE_IMAGE_MAX_SIZE = 2560;

// The part extension of each type encodeOfficeImage writes, which an Office package embeds as is.
const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const RASTER_EXTENSIONS = new Map(
    [...IMAGE_EXTENSION_BY_MIME].filter(([contentType]) => RASTER_TYPES.has(contentType)),
);

// The [Content_Types].xml Defaults of an Office image's parts: its raster, and an SVG's own beside its PNG.
export const OFFICE_IMAGE_CONTENT_TYPES: Record<string, string> = {
    ...Object.fromEntries([...RASTER_EXTENSIONS].map(([contentType, extension]) => [extension, contentType])),
    svg: 'image/svg+xml',
};

// Lossless codings, which PNG keeps pixel for pixel. Every other type but WebP takes JPEG, a photo's size; one with
// alpha retries as PNG.
const PNG_SOURCES = new Set(['image/png', 'image/gif']);

// An Office image is a WebP as it is, else a PNG or JPEG made from its source. `encode` is sharpResize, in the thumbnail
// Worker for a media file and in the transform process for a data: src; its re-encode drops the EXIF, GPS included.
// A WebP keeps `source`, its file's bytes, EXIF and all, unless it is larger than OFFICE_IMAGE_MAX_SIZE; any other
// type, which never keeps them, may pass null and leave the read to the Worker.
export async function encodeOfficeImage(
    name: string,
    mime: string,
    source: Buffer | null,
    encode: (options: WorkerInput['options']) => Promise<ImageResult | null>,
): Promise<ExportMedia | null> {
    let format: 'png' | 'jpeg' | 'webp' = mime === 'image/webp' ? 'webp' : PNG_SOURCES.has(mime) ? 'png' : 'jpeg';
    const encodeAs = (format: 'png' | 'jpeg' | 'webp') =>
        encode({ format, maxSize: OFFICE_IMAGE_MAX_SIZE, quality: 80, fit: 'inside' });
    let result = await encodeAs(format);
    // JPEG has no alpha: a source that holds one (an AVIF, a PNG stored as JPEG) takes PNG.
    if (result?.hasAlpha && format === 'jpeg') {
        format = 'png';
        result = await encodeAs(format);
    }
    if (!result) return null;
    const { width, height } = result;
    // The Worker reports the source's size, so a WebP that fits keeps its own bytes and the re-encode is dropped.
    const kept = format === 'webp' && Math.max(width, height) <= OFFICE_IMAGE_MAX_SIZE ? source : null;
    const data = toTransferableBuffer(kept ?? result.data);
    return { name, contentType: `image/${format}`, data, width, height };
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
                .resize(OFFICE_IMAGE_MAX_SIZE, OFFICE_IMAGE_MAX_SIZE, { fit: 'inside', withoutEnlargement: true })
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
