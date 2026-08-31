import { EIGEN_MEDIA_SCHEME, eigenMediaHref, listEigenMediaRefs, stripEigenMediaRefs } from '@workspace/lib/vector';
import type { Mount } from '../mount';

// Serve-time media inliner for image-bearing vector SVGs (SVG-IMAGE-PASTE-PLAN R4). A stored .svg
// references each image BY NAME — `href="eigen-media:<name>"` — never by bytes, so a container copy
// resolves against the copy's own media/ siblings. An SVG rendered through <img> never fetches
// external references (spec), so the ONLY place a name can become pixels is here: on the way out of
// the preview route we swap each name-ref for a `data:` URI of the sibling's bytes.
//
// The raw SVG is treated as HOSTILE bytes. The load-bearing safety rails, in order:
//   - name resolution is SAME-FOLDER only (mount.getChildByName over the svg's own parent); the codec
//     (listEigenMediaRefs → parseEigenMediaHref) already dropped any ref whose decoded name carries
//     `/`, `\`, or a control char, so no lookup can escape the container.
//   - a sibling that is itself a name-ref svg is inlined first, bounded by MAX_SVG_INLINE_DEPTH.
//   - total output is capped at SVG_INLINE_MAX_BYTES; a breach degrades (refs stripped), never 500s.
//
// The result rides the existing `{pathId}-{updatedAt}.screen.svg` cache key, so every display surface
// and the export path (export/media.ts prepareMedia calls getScreenPreview too) get it for free.
// Accepted staleness: a sibling edit/rename/delete does not bump the svg's own updatedAt, so a cached
// preview can outlive the swap until the svg itself changes — a media rename already breaks every name
// reference in the suite today.

// ~16MB served-output ceiling. base64 inflates ~1.37x, so a few MB of siblings fit; a hostile blow-up
// (one big sibling referenced many times, or deep nesting) trips this and degrades to a stripped svg.
export const SVG_INLINE_MAX_BYTES = 16 * 1024 * 1024;

// svg-in-svg recursion ceiling: the served svg is depth 0, a referenced sibling svg is depth 1. A
// sibling svg deeper than this is stripped rather than inlined.
export const MAX_SVG_INLINE_DEPTH = 3;

// Sniffed on the raw bytes so a plain drawing with no refs never pays a utf8 decode.
const SNIFF = Buffer.from(EIGEN_MEDIA_SCHEME);

// Thrown when the running output would exceed the ceiling; caught at the top to serve a stripped svg.
class OutputTooLargeError extends Error {}

// The tracked byte budget for one inline pass, threaded through nested svg recursion so a blow-up at
// any depth is caught before the giant string is materialised.
type Budget = { remaining: number };

// Inline every resolvable `eigen-media:` ref in `svgBytes` into a `data:` URI, resolving siblings by
// name in `parentId`. Returns the served bytes: the original buffer byte-identical when there are no
// refs, the inlined svg when they resolve, or the svg with all refs stripped when the output ceiling
// is breached.
export async function inlineSvgMediaRefs(mount: Mount, parentId: string, svgBytes: Buffer): Promise<Buffer> {
    // Cheap byte-level sniff: a drawing with no name-refs takes today's path, byte-identical.
    if (!svgBytes.includes(SNIFF)) return svgBytes;

    const original = svgBytes.toString('utf8');
    const budget: Budget = { remaining: SVG_INLINE_MAX_BYTES - Buffer.byteLength(original) };
    try {
        const inlined = await resolveSvgRefs(mount, parentId, original, 0, budget);
        const out = Buffer.from(inlined, 'utf8');
        // Multibyte counting can undershoot the char-based budget; the byte length is the real gate.
        if (out.byteLength > SVG_INLINE_MAX_BYTES) return stripAll(original);
        return out;
    } catch (err) {
        if (err instanceof OutputTooLargeError) return stripAll(original);
        throw err;
    }
}

// Serve the drawing with every ref stripped — images render blank, but the svg stays small and safe.
function stripAll(svg: string): Buffer {
    return Buffer.from(stripEigenMediaRefs(svg, listEigenMediaRefs(svg)), 'utf8');
}

async function resolveSvgRefs(
    mount: Mount,
    parentId: string,
    svg: string,
    depth: number,
    budget: Budget,
): Promise<string> {
    // Distinct, already-safe names (the codec dropped traversal/injection refs) in first-seen order.
    const names = listEigenMediaRefs(svg);
    if (names.length === 0) return svg;

    let out = svg;
    const strip: string[] = [];
    for (const name of names) {
        // Exact-token, quote-bounded needle: rebuild the stored token with eigenMediaHref and match
        // every `"<token>"`. sceneToSvg writes double-quoted hrefs and the token percent-encodes every
        // quote/angle/space, so this never mis-hits surrounding markup.
        const token = eigenMediaHref(name);
        const needle = `"${token}"`;
        const occurrences = out.split(needle).length - 1;
        if (occurrences === 0) continue; // ref present but not as a quoted href attribute — nothing to inline
        // resolveRef charges the budget against `occurrences` BEFORE it reads/encodes a leaf, so a huge
        // sibling degrades the whole pass without ever being pulled into memory.
        const dataUri = await resolveRef(mount, parentId, name, depth, budget, occurrences, token.length);
        if (dataUri === null) {
            strip.push(name);
            continue;
        }
        out = out.split(needle).join(`"${dataUri}"`);
    }
    return strip.length > 0 ? stripEigenMediaRefs(out, strip) : out;
}

// Resolve one media name to a `data:` URI, or null to signal "strip this ref" (missing sibling, a
// non-file match, a sibling too deep to recurse, or an unreadable object). Charges `budget` for the
// projected growth (`occurrences` copies of the URI minus the token it replaces); a breach throws
// OutputTooLargeError, caught at the top to degrade to a stripped svg.
async function resolveRef(
    mount: Mount,
    parentId: string,
    name: string,
    depth: number,
    budget: Budget,
    occurrences: number,
    tokenLen: number,
): Promise<string | null> {
    const child = await mount.getChildByName(parentId, name);
    if (child?.type !== 'file') return null;

    if (child.mimeType === 'image/svg+xml') {
        // A sibling svg may carry its own name-refs — inline them first, then embed the whole thing.
        // The recursion charges its own leaves; the byte size is bounded by the depth cap, so the svg
        // data URI is built (small, capped at depth 3) and only then charged.
        if (depth + 1 > MAX_SVG_INLINE_DEPTH) return null;
        const file = await mount.readFile(child.id);
        if (!file) return null;
        const bytes = Buffer.from(await file.arrayBuffer());
        const inner = bytes.includes(SNIFF)
            ? Buffer.from(await resolveSvgRefs(mount, parentId, bytes.toString('utf8'), depth + 1, budget), 'utf8')
            : bytes;
        const uri = svgDataUri(inner);
        charge(budget, occurrences, uri.length, tokenLen);
        return uri;
    }

    // Non-svg leaf: `child.mimeType` is client-supplied at upload, so validate it before it lands in a
    // data: URI — a crafted type carrying a `"` would otherwise break out of the href (defense in depth
    // behind the sandbox CSP). base64 length is deterministic from the DECLARED size, so charge the
    // budget from `child.size` BEFORE reading/encoding: a leaf too big to fit degrades the whole pass
    // without ever being pulled into memory.
    const mime = safeDataUriMime(child.mimeType);
    const projectedLen = `data:${mime};base64,`.length + base64Len(child.size);
    charge(budget, occurrences, projectedLen, tokenLen);
    const file = await mount.readFile(child.id);
    if (!file) return null;
    const bytes = Buffer.from(await file.arrayBuffer());
    return `data:${mime};base64,${bytes.toString('base64')}`;
}

// Deduct `occurrences` copies of the URI (net of the token each replaces) from the budget; a breach
// throws so the top-level catch degrades to a stripped svg. A URI shorter than the token nets a
// negative charge (the output shrinks) — harmless.
function charge(budget: Budget, occurrences: number, uriLen: number, tokenLen: number): void {
    budget.remaining -= occurrences * (uriLen - tokenLen);
    if (budget.remaining < 0) throw new OutputTooLargeError();
}

// Exact base64 length for a byte count (`4 * ceil(n / 3)`, padding included).
function base64Len(byteLen: number): number {
    return 4 * Math.ceil(byteLen / 3);
}

// A `type/subtype` shape of unreserved token chars only — rejects any client-supplied mime that could
// carry a `"`, whitespace, or other href-breaking byte, falling back to a neutral binary type.
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;
function safeDataUriMime(mimeType: string): string {
    return MIME_RE.test(mimeType) ? mimeType : 'application/octet-stream';
}

// base64 (not utf8) so the svg payload can never break out of the enclosing href attribute.
function svgDataUri(bytes: Buffer): string {
    return `data:image/svg+xml;base64,${bytes.toString('base64')}`;
}
