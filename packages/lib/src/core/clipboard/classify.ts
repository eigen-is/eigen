import type { EigenClipboardData, EigenClipboardItem } from '../../types/clipboard';
import { readEigenClipboard, readSvgClipboardWithItems } from './clipboard';

// The SVG flavour, resolved once. `svg` + `items` are the materialize-as-image inputs (docs/slides/
// sheets). Restoring our own copies to native elements is vector-local: vector calls
// extractClipboardSvgMetadata on `svg` itself at its svg rung, so that split lives with its one reader.
export type ClassifiedSvg = {
    svg: string;
    items: EigenClipboardItem[];
};

export type ClassifiedPaste = {
    svg?: ClassifiedSvg;
    eigen?: EigenClipboardData;
    imageFiles: File[];
    files: File[];
    html: string;
    text: string;
};

// One classification pass over an already-obtained DataTransfer, resolving every present clipboard
// flavour once (with the subtle guards baked in) so each app keeps only a short ladder that reads the
// fields in its own priority order and calls its own per-kind handlers. Sync — every reader it composes
// is sync; the async menu paths only ever want eigen items and keep readEigenClipboardAsync.
//
// It composes the existing readers, never re-implementing their parsing: readSvgClipboardWithItems /
// readEigenClipboard. The eigen payload is parsed exactly once here and handed to
// readSvgClipboardWithItems so the svg flavour is derived from it without a second parse. Consumers
// that gate on rich html (docs) call hasRichHtmlBeyondMarker themselves — no pass over text/html here.
export function classifyPaste(cd: DataTransfer, opts?: { internalMarkerText?: string }): ClassifiedPaste {
    const html = cd.getData('text/html');
    const text = cd.getData('text/plain');
    const files = Array.from(cd.files);
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));

    // Sheets' same-tab copy writes a table marker in text/html and serves paste from ctx.copyState, not
    // the eigen wire — so an internal copy suppresses the eigen + svg flavours entirely (the caller then
    // falls through to its native table paste). One place owns the marker-skip; every other app passes no
    // internalMarkerText and never trips it.
    const internalMarker = opts?.internalMarkerText ? html.includes(opts.internalMarkerText) : false;

    const eigenData = internalMarker ? null : readEigenClipboard(cd);
    const svgPayload = internalMarker ? null : readSvgClipboardWithItems(cd, eigenData);

    return {
        svg: svgPayload ?? undefined,
        eigen: eigenData ?? undefined,
        imageFiles,
        files,
        html,
        text,
    };
}
