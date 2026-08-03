import type { TransformWarning } from '../document/transform/protocol';

// Appended to compact quick-look previews when content was dropped to keep the
// cached body small. Inline-styled because preview HTML is embedded without the
// document <head>, so external CSS isn't available. Muted color (#6b7280) matches
// the resolved --color-muted-foreground used elsewhere in the export pipeline.
export function renderPreviewTruncatedMarker(): string {
    return '<div style="margin:1rem 0;text-align:center;color:#6b7280;font-size:13px">Preview truncated — open to see everything</div>';
}

// Final defense in depth after each type's own budget: a body past this size is
// replaced by a small valid truncated notice, never a partially sliced string. The
// per-type budgets count blocks, slides or cells — one enormous block sails through
// all of them.
const MAX_PREVIEW_BODY_BYTES = 8_000_000;

export function applyPreviewByteGuard(body: string, warnings: TransformWarning[]): string {
    const bytes = Buffer.byteLength(body);
    if (bytes <= MAX_PREVIEW_BODY_BYTES) return body;
    warnings.push({ code: 'byte-guard-truncated', bytes });
    return renderPreviewTruncatedMarker();
}
