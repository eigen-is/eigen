// Shared XML text/attribute escaping for everything here that writes XML by hand: the WebDAV +
// CalDAV response builders and the S3 bucket-configuration bodies. The WebDAV and CalDAV
// multistatus/response/propstat envelopes legitimately differ (whitespace, namespace decls), but
// this escape is the same everywhere — one source of truth so the callers can't drift.
export function escapeXml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
