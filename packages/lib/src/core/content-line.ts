// RFC 2425 §5.8.1 MIME-directory content-line primitives, shared by the iCalendar (caldav) and vCard
// (carddav) serializers — the fold and escape algorithms are identical across both formats, so they live
// here as the one source of truth.

// A C0 control byte illegal in XML character data — below 0x20 except TAB, CR, LF. One such byte echoed into
// a REPORT's address-data/calendar-data invalidates the XML client-side and wedges DAV sync. The serialize
// seams below STRIP these; the vCard ingest parse REJECTS them (../vcard/ast.ts). A code-point check, not a
// regex: biome rejects \x00-\x1F, and \p{Cc} would also hit the C1 controls, which are valid XML.
export function isIllegalC0(code: number): boolean {
    return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
}

// Drop illegal C0 bytes. TAB is a legal TEXT/fold char; CR and LF stay so each caller applies its own CR/LF
// semantics (escaped, or stripped) afterwards.
export function stripControlChars(s: string): string {
    let out = '';
    for (const ch of s) {
        if (isIllegalC0(ch.charCodeAt(0))) continue;
        out += ch;
    }
    return out;
}

// RFC 5545 §3.3.11 / RFC 2426 §2.4.2 — escape TEXT values: backslash, semicolon, comma, and newline. Illegal
// C0 control bytes are dropped first (see stripControlChars). A bare CR is dropped: it isn't a TEXT char, and
// a stray CR would split the value into a new property line on the next parse — a property-injection
// primitive through user-supplied fields.
export function escapeContentText(s: string): string {
    return stripControlChars(s)
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '');
}

// Neuter a value for use inside a PARAM-VALUE (e.g. CN="..."): illegal C0 controls are dropped, double quotes
// would break out of the parameter (neither format has a quote escape), CRLF could inject properties.
export function neuterParamValue(s: string): string {
    return stripControlChars(s)
        .replace(/"/g, "'")
        .replace(/[\r\n]/g, '');
}

// Strip CR/LF (and any other illegal C0 control) from a value written into a content line verbatim — an
// opaque id/token (vCard X-EIGEN-ID) or a mailto address that is neither TEXT-escaped nor quoted. Only bytes
// that could split the value into a new content line (RFC 2425 §5.8.1) or invalidate the REPORT XML are
// removed, so the value keeps its shape (escaping/neutering would reshape an arbitrary id) while the injection
// path stays closed.
export function stripLineBreaks(s: string): string {
    return stripControlChars(s).replace(/[\r\n]/g, '');
}

// RFC 2425 §5.8.1 — split into logical lines, unfolding continuations: a physical line starting with a single
// SPACE or TAB continues the previous one, so the line break and that one whitespace char go. Each line keeps
// `raw`, the exact source slice including its internal folding, so a line nobody rewrites re-emits verbatim.
// Empty logical lines (blank physical lines, e.g. the trailing CRLF Outlook exports leave) carry no property
// and are dropped, so byte-identity of a payload with blanks is not preserved — the blanks simply go.
export function unfoldContentLines(text: string): { raw: string; logical: string }[] {
    const lines: { start: number; end: number; logical: string }[] = [];
    let i = 0;
    const n = text.length;
    while (i < n) {
        const start = i;
        let j = i;
        while (j < n && text[j] !== '\n' && text[j] !== '\r') j++;
        const content = text.slice(i, j);
        if (j >= n) i = j;
        else if (text[j] === '\r' && text[j + 1] === '\n') i = j + 2;
        else i = j + 1;

        const first = content.charCodeAt(0);
        if ((first === 0x20 || first === 0x09) && lines.length > 0) {
            const cur = lines[lines.length - 1];
            cur.end = j;
            cur.logical += content.slice(1);
        } else {
            lines.push({ start, end: j, logical: content });
        }
    }
    return lines.filter((l) => l.logical !== '').map((l) => ({ raw: text.slice(l.start, l.end), logical: l.logical }));
}

// RFC 5545 §3.1 / RFC 2425 §5.8.1 — fold lines longer than 75 octets with CRLF + single space.
export function foldLine(line: string): string {
    const bytes = new TextEncoder().encode(line);
    if (bytes.length <= 75) return line;

    const parts: string[] = [];
    let offset = 0;
    let first = true;

    while (offset < bytes.length) {
        const limit = first ? 75 : 74; // continuation lines lose 1 octet to the leading space
        first = false;

        // Walk back from limit so we never split a multi-byte character
        let end = Math.min(offset + limit, bytes.length);
        // If the byte at `end` is a UTF-8 continuation byte (10xxxxxx), back up
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
            end--;
        }

        parts.push(new TextDecoder().decode(bytes.slice(offset, end)));
        offset = end;
    }

    return parts.join('\r\n ');
}
