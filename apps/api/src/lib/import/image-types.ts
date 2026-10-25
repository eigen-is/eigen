// The pictures an Office import brings in: which parts, by type, each read raw and never parsed, and each one media
// file named per import, so an import beside an earlier one's pictures overwrites none. The docx, pptx and xlsx readers
// share these rules and the caps on how many and how many bytes.

import { IMAGE_EXTENSION_BY_MIME, MIME_ALIASES } from '../ooxml/drawingml';
import type { OoxmlPackage, Relationship } from '../ooxml/opc';
import { relTarget } from '../ooxml/opc';
import type { ZipReader } from '../ooxml/zip';

// What an import stores a picture part as: a docx every type it has an extension for, as Word keeps a figure it can't
// draw; a slide and a sheet only those they draw. Any other, for a deck or a workbook an EMF, a WMF or a TIFF, is left
// out and counted.
export const IMAGE_TYPES: ReadonlySet<string> = new Set(IMAGE_EXTENSION_BY_MIME.keys());
const PICTURE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml']);

// The picture parts one import brings in, at most.
export const MAX_MEDIA_PARTS = 1000;

export type MediaPart = { path: string; contentType: string; extension: string; size: number };

// The part at `path` as one of `types`, of the content type the format reads it as, if the package holds it.
export function mediaPart(
    zip: ZipReader,
    path: string,
    contentType: string | undefined,
    types: ReadonlySet<string>,
): MediaPart | undefined {
    const extension = contentType && types.has(contentType) && IMAGE_EXTENSION_BY_MIME.get(contentType);
    const entry = zip.entry(path);
    return contentType && extension && entry ? { path, contentType, extension, size: entry.size } : undefined;
}

// The picture part an r:embed names under the format's folder: one of the types a slide or a sheet draws, declared so
// in [Content_Types].xml, and in the package.
export function pictureMediaPart(
    pkg: OoxmlPackage,
    rels: ReadonlyMap<string, Relationship>,
    id: string | undefined,
    folder: string,
): MediaPart | undefined {
    const path = relTarget(rels, id, 'image');
    if (!path?.startsWith(folder)) return undefined;
    const declared = pkg.contentTypeOf(path);
    return mediaPart(pkg.zip, path, declared && (MIME_ALIASES.get(declared) ?? declared), PICTURE_TYPES);
}

export type ImportedMedia = { name: string; contentType: string; data: Buffer };

// An import's pictures as it names them: the media files read, and the name of a part, which reads it.
export type MediaFiles = { media: ImportedMedia[]; name(part: MediaPart): string | undefined | null };

// One media file per picture part, read as it is first named: its format, a prefix of its own per import and the
// order of first use. A part past MAX_MEDIA_PARTS or the pictures' bytes past `maxBytes` is `null`, which the format
// refuses or leaves out; one whose bytes don't read is undefined.
export function importMedia(
    format: 'docx' | 'pptx' | 'xlsx',
    read: (path: string) => Uint8Array | undefined,
    maxBytes: number,
): MediaFiles {
    const prefix = `${format}-${crypto.randomUUID()}`;
    const media: ImportedMedia[] = [];
    const names = new Map<string, string | undefined>();
    let bytes = 0;
    return {
        media,
        name: (part) => {
            if (names.has(part.path)) return names.get(part.path);
            if (names.size >= MAX_MEDIA_PARTS || bytes + part.size > maxBytes) return null;
            bytes += part.size;
            const data = read(part.path);
            const name = data && `${prefix}-image-${media.length + 1}.${part.extension}`;
            // A view of the bytes read, not a copy of them.
            if (data && name)
                media.push({
                    name,
                    contentType: part.contentType,
                    data: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
                });
            names.set(part.path, name);
            return name;
        },
    };
}
