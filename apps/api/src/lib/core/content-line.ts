// RFC 2425 §5.8.1 MIME-directory content-line primitives, shared by the iCalendar (caldav) and vCard
// (carddav) serializers — the fold and escape algorithms are identical across both formats, so they live
// here as the one source of truth.

// Drop the C0 control bytes that are illegal in XML character data — everything below 0x20 except TAB, CR,
// and LF. Every value that reaches a content line passes through here (via the three seams below): a raw C0
// byte (e.g. a pasted vertical tab in a note or an event title), stored verbatim and echoed into a full-book
// address-data / calendar-data REPORT, renders that XML invalid client-side and wedges the account's DAV
// sync. TAB is a legal TEXT/fold char and stays; CR and LF stay here so each caller applies its own CR/LF
// semantics (escaped, or stripped) afterwards. A code-point scan, not a \x00-\x1F regex — biome's
// noControlCharactersInRegex rejects the latter, and a \p{Cc} regex would also strip the C1 controls, which
// are valid XML characters.
function stripControlChars(s: string): string {
    let out = '';
    for (const ch of s) {
        const code = ch.charCodeAt(0);
        if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
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
