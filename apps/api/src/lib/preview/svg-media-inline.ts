// The serve-time inliner for vector SVGs. A stored SVG names each image by its media file, never by its bytes, so a
// copied container resolves against its own media. An SVG drawn through <img> fetches nothing, so on the way out of
// the preview, each name becomes a data: URI of the file's bytes, and the font slices its text draws with are
// embedded too. The screen preview cache calls it, and a sweep of a document's media keeps what it would inline.

import { EIGEN_MEDIA_SCHEME, eigenMediaHref, listEigenMediaRefs, stripEigenMediaRefs } from '@workspace/lib/vector';
import { spliceAfterSvgOpenTag } from '@workspace/lib/xml';
import { drawnCodePoints, namedFamilies, slicesFaceCss } from '../export/fonts';
import type { Mount } from '../mount';

// The raw SVG is hostile bytes, and three rails keep it safe:
//   - A name resolves in the svg's own folder only, through mount.getChildByName. The codec behind listEigenMediaRefs
//     has already dropped every ref whose decoded name holds `/`, `\` or a control character, so no lookup leaves the
//     container.
//   - A sibling that is itself an svg with name refs is inlined first, at most MAX_SVG_INLINE_DEPTH deep.
//   - The output is capped at SVG_INLINE_MAX_BYTES. Past it the refs are stripped, never a 500.
//
// The result shares the screen preview's cache key, `{pathId}-{updatedAt}.screen.svg`, so every display surface and
// the export's prepareMedia, which calls getScreenPreview too, get it for free. A sibling's edit, rename or delete
// leaves the svg's updatedAt alone, so a cached preview outlives it until the svg itself changes.

// The most a served svg may weigh. base64 grows bytes by about 1.37 times, so a few MB of siblings fit. A hostile
// blow-up, such as one big sibling named many times or deep nesting, trips it and serves a stripped svg.
export const SVG_INLINE_MAX_BYTES = 16 * 1024 * 1024;

// How deep svgs inline into svgs: the served svg is depth 0 and a sibling svg it names is depth 1. A sibling svg
// deeper than this is stripped rather than inlined.
const MAX_SVG_INLINE_DEPTH = 3;

// Sniffed on the raw bytes, so a plain drawing with no refs never pays a utf8 decode.
const MEDIA_SNIFF = Buffer.from(EIGEN_MEDIA_SCHEME);

// The font pass runs only for an svg that names a font-family. An svg that already holds an @font-face, as an export
// or this inliner's own cached output does, gets no second block of slices.
const FONT_FAMILY_SNIFF = Buffer.from('font-family');
const FONT_FACE_SNIFF = Buffer.from('@font-face');

// Thrown when the running output would exceed the ceiling; caught at the top to serve a stripped svg.
class OutputTooLargeError extends Error {}

// The bytes one inline pass may still add. It is passed down through nested svgs, so a blow-up at any depth is caught
// before the giant string is built.
type Budget = { remaining: number };

// Every `eigen-media:` ref that resolves to a sibling in `parentId` becomes a `data:` URI, and the font slices its text
// draws with are added, so a drawing shown through <img> draws its images and its text without reaching outside itself.
// With nothing to inline the original buffer comes back unchanged. Past the output ceiling the svg comes back with
// every media ref stripped.
export async function inlineSvgMediaRefs(mount: Mount, parentId: string, svgBytes: Buffer): Promise<Buffer> {
    const hasMedia = svgBytes.includes(MEDIA_SNIFF);
    const needsFonts = svgBytes.includes(FONT_FAMILY_SNIFF) && !svgBytes.includes(FONT_FACE_SNIFF);
    // Nothing to inline or inject: serve the bytes untouched, without a utf8 round-trip.
    if (!hasMedia && !needsFonts) return svgBytes;

    const original = svgBytes.toString('utf8');
    const budget: Budget = { remaining: SVG_INLINE_MAX_BYTES - Buffer.byteLength(original) };
    try {
        let result = hasMedia ? await resolveSvgRefs(mount, parentId, original, 0, budget) : original;
        if (needsFonts) result = injectFontFaces(result, budget);
        if (result === original) return svgBytes;
        const out = Buffer.from(result, 'utf8');
        // The budget counts UTF-16 units, which undercount multibyte characters, so the byte length is the real gate.
        if (out.byteLength > SVG_INLINE_MAX_BYTES) return stripAll(original);
        return out;
    } catch (err) {
        if (err instanceof OutputTooLargeError) return stripAll(original);
        throw err;
    }
}

// The names given and every sibling an svg among them pulls in when it is served, to the depth the inliner reads, so a
// sweep or a copy keeps what the svg draws. A missing file or one that is no svg adds nothing. A sibling a leaf at the
// last depth names is kept too, which only keeps more.
export async function withSvgSiblings(mount: Mount, parentId: string, names: Iterable<string>): Promise<Set<string>> {
    const kept = new Set(names);
    let svgs = [...kept];
    for (let depth = 0; depth <= MAX_SVG_INLINE_DEPTH && svgs.length > 0; depth++) {
        const next: string[] = [];
        for (const name of svgs) {
            const child = await mount.getChildByName(parentId, name);
            if (child?.type !== 'file' || child.mimeType !== 'image/svg+xml') continue;
            const bytes = await mount.readBytes(child.id);
            if (!bytes) continue;
            for (const ref of listEigenMediaRefs(Buffer.from(bytes).toString('utf8'))) {
                if (kept.has(ref)) continue;
                kept.add(ref);
                next.push(ref);
            }
        }
        svgs = next;
    }
    return kept;
}

async function resolveSvgRefs(
    mount: Mount,
    parentId: string,
    svg: string,
    depth: number,
    budget: Budget,
): Promise<string> {
    // Distinct names in first-seen order, already safe, since the codec dropped every traversal or injection ref.
    const names = listEigenMediaRefs(svg);
    if (names.length === 0) return svg;

    let out = svg;
    const strip: string[] = [];
    for (const name of names) {
        // The needle is the stored token in double quotes, rebuilt with eigenMediaHref. sceneToSvg writes double-quoted
        // hrefs and the token percent-encodes every quote, angle bracket and space, so it never matches other markup.
        const token = eigenMediaHref(name);
        const needle = `"${token}"`;
        const occurrences = out.split(needle).length - 1;
        // A ref that is not a quoted href has nothing to inline.
        if (occurrences === 0) continue;
        // resolveRef charges the budget for every occurrence before it reads a leaf, so a huge sibling degrades the
        // whole pass without ever being read into memory.
        const dataUri = await resolveRef(mount, parentId, name, depth, budget, occurrences, token.length);
        if (dataUri === null) {
            strip.push(name);
            continue;
        }
        out = out.split(needle).join(`"${dataUri}"`);
    }
    return strip.length > 0 ? stripEigenMediaRefs(out, strip) : out;
}

// One media name as a `data:` URI, or null to strip the ref: a missing sibling, a match that is no file, a sibling svg
// too deep or an unreadable object. It charges the budget for `occurrences` copies of the URI, less the token each
// replaces. A breach throws OutputTooLargeError, which the top level turns into a stripped svg.
async function resolveRef(
    mount: Mount,
    parentId: string,
    name: string,
    depth: number,
    budget: Budget,
    occurrences: number,
    tokenLength: number,
): Promise<string | null> {
    const child = await mount.getChildByName(parentId, name);
    if (child?.type !== 'file') return null;

    if (child.mimeType === 'image/svg+xml') {
        // A sibling svg may name media of its own, which is inlined first, and then the whole svg is embedded. The
        // recursion charges its own leaves, and the final URI is charged after it.
        if (depth + 1 > MAX_SVG_INLINE_DEPTH) return null;
        // The final URI is charged only after the nested pass, so the sibling's declared size is checked before it is
        // read: a sibling too big degrades the pass without ever being read, as a leaf does below.
        if (base64Length(child.size) > budget.remaining) throw new OutputTooLargeError();
        const stored = await mount.readBytes(child.id);
        if (!stored) return null;
        const bytes = Buffer.from(stored);
        const inner = bytes.includes(MEDIA_SNIFF)
            ? Buffer.from(await resolveSvgRefs(mount, parentId, bytes.toString('utf8'), depth + 1, budget), 'utf8')
            : bytes;
        const uri = svgDataUri(inner);
        charge(budget, occurrences, uri.length, tokenLength);
        return uri;
    }

    // Any other leaf. The client sets `child.mimeType` at upload, so it is checked before it lands in a data: URI, where
    // a `"` in it would break out of the href, behind the sandbox CSP. The base64 length follows from the declared
    // size, so the budget is charged before the read: a leaf too big degrades the whole pass without ever being read.
    const mime = safeDataUriMime(child.mimeType);
    const projectedLength = `data:${mime};base64,`.length + base64Length(child.size);
    charge(budget, occurrences, projectedLength, tokenLength);
    const bytes = await mount.readBytes(child.id);
    if (!bytes) return null;
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

// A URI shorter than its token charges a negative amount, as the output shrinks, which is harmless.
function charge(budget: Budget, occurrences: number, uriLength: number, tokenLength: number): void {
    budget.remaining -= occurrences * (uriLength - tokenLength);
    if (budget.remaining < 0) throw new OutputTooLargeError();
}

// The exact base64 length of a byte count, padding included.
function base64Length(byteLength: number): number {
    return 4 * Math.ceil(byteLength / 3);
}

// A `type/subtype` of token characters only. Any other type, which could hold a `"`, a space or another byte that
// breaks the href, becomes a neutral binary one.
const SAFE_MIME = /^[\w.+-]+\/[\w.+-]+$/;

function safeDataUriMime(mimeType: string): string {
    return SAFE_MIME.test(mimeType) ? mimeType : 'application/octet-stream';
}

// base64 rather than utf8, so the svg can never break out of the href around it.
function svgDataUri(bytes: Buffer): string {
    return `data:image/svg+xml;base64,${bytes.toString('base64')}`;
}

// The slices its text draws with, in the bundled families it names. A drawing names the emoji and CJK fallbacks in its
// stacks, while an older or uploaded SVG that names Inter alone gets no slice of theirs. The slices are data: URIs, so
// sanitizeExportHtml keeps them and the sandbox CSP allows them. They are static per build, so a cached result never
// goes stale. Past the output budget the svg serves without them and keeps its media.
function injectFontFaces(svg: string, budget: Budget): string {
    const used = namedFamilies(svg);
    if (used.size === 0) return svg;
    const faceCss = slicesFaceCss(drawnCodePoints(svg), used);
    // An SVG that names only a fallback, with none of that fallback's characters, needs no slice.
    if (faceCss === '') return svg;
    const defs = `<defs><style>${faceCss}</style></defs>`;
    budget.remaining -= Buffer.byteLength(defs);
    if (budget.remaining < 0) return svg;
    return spliceAfterSvgOpenTag(svg, defs);
}

// The drawing with every ref stripped: its images draw blank, but the svg stays small and safe.
function stripAll(svg: string): Buffer {
    return Buffer.from(stripEigenMediaRefs(svg, listEigenMediaRefs(svg)), 'utf8');
}
