import { type OoxmlPackage, type Relationship, relTarget } from '../ooxml/opc';

// The image types an import stores a picture part as, each under its own extension. WMF and EMF are kept though no
// browser or sharp draws them: the docx reader leaves its figure's alt text in a broken image.
export const IMAGE_EXTENSION_BY_MIME = new Map([
    ['image/png', 'png'],
    ['image/jpeg', 'jpeg'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
    ['image/svg+xml', 'svg'],
    ['image/tiff', 'tiff'],
    ['image/bmp', 'bmp'],
    ['image/x-wmf', 'wmf'],
    ['image/x-emf', 'emf'],
]);

// image/jpg is a common misspelling of a part's declared type.
export const MIME_ALIASES = new Map([['image/jpg', 'image/jpeg']]);

// The pictures a pptx or xlsx import brings in, read raw, never parsed: of the types an import stores, those a slide
// and a sheet draw. Any other, an EMF, a WMF or a TIFF, is left out and counted.
const PICTURE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml']);

// The picture parts one import brings in, at most.
export const MAX_MEDIA_PARTS = 1000;

export type MediaPart = { path: string; contentType: string; extension: string; size: number };

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
    const contentType = declared && (MIME_ALIASES.get(declared) ?? declared);
    const extension = contentType && PICTURE_TYPES.has(contentType) && IMAGE_EXTENSION_BY_MIME.get(contentType);
    const entry = pkg.zip.entry(path);
    return contentType && extension && entry ? { path, contentType, extension, size: entry.size } : undefined;
}

export type ImportedMedia = { name: string; contentType: string; data: Buffer };

// An import's media names: its format, a prefix of its own and the order of first use, so an import beside an earlier
// one's pictures overwrites none.
export function mediaNamer(format: 'docx' | 'pptx' | 'xlsx'): (index: number, extension: string) => string {
    const prefix = `${format}-${crypto.randomUUID()}`;
    return (index, extension) => `${prefix}-image-${index}.${extension}`;
}

// One media file per picture part, read as it is first named, by mediaNamer. A part past MAX_MEDIA_PARTS or the
// pictures' bytes past `maxBytes` is `null`, which the format refuses or leaves out; one whose bytes don't read is
// undefined.
export function importMedia(
    format: 'pptx' | 'xlsx',
    read: (path: string) => Uint8Array | undefined,
    maxBytes: number,
): { media: ImportedMedia[]; name(part: MediaPart): string | undefined | null } {
    const named = mediaNamer(format);
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
            const name = data && named(media.length + 1, part.extension);
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
