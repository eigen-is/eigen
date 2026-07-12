// Shared XML text/attribute escaping for the WebDAV + CalDAV response builders. Their
// multistatus/response/propstat envelopes legitimately differ (whitespace, namespace decls),
// but this escape is byte-identical in both — one source of truth so the two can't drift.
export function escapeXml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
