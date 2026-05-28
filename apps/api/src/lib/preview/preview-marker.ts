// Appended to compact quick-look previews when content was dropped to keep the
// cached body small. Inline-styled because preview HTML is embedded without the
// document <head>, so external CSS isn't available. Muted color (#6b7280) matches
// the resolved --color-muted-foreground used elsewhere in the export pipeline.
export function renderPreviewTruncatedMarker(): string {
    return '<div style="margin:1rem 0;text-align:center;color:#6b7280;font-size:13px">Preview truncated — open to see everything</div>';
}
