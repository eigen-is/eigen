// Hand-rolled vCard content-line AST (RFC 2426 / RFC 6350 §3). Parses a vCard into logical lines and
// serializes them back, keeping the exact source bytes of any line we don't rewrite so an untouched
// card round-trips byte-for-byte through a CardDAV GET. The fold and TEXT-escape algorithms are the
// shared MIME-directory primitives in core/content-line.
import { foldLine, neuterParamValue } from '../core/content-line';

export class VCardError extends Error {}

export type VCardLine = {
    group: string | null; // 'item1' for 'item1.EMAIL;…', else null
    name: string; // property name, UPPERCASED ('EMAIL')
    params: [string, string][]; // parameter name (UPPERCASED) / raw value, original order, quotes stripped
    value: string; // raw property value, unfolded, NOT unescaped
    raw: string | null; // exact source slice incl. original folding/CRLFs; null for built lines
};

// First index of `ch` in `s` that sits outside a double-quoted section, or -1.
function indexOfOutsideQuotes(s: string, ch: string): number {
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '"') quoted = !quoted;
        else if (c === ch && !quoted) return i;
    }
    return -1;
}

// Split on `delim`, ignoring delimiters inside double quotes.
function splitOutsideQuotes(s: string, delim: string): string[] {
    const parts: string[] = [];
    let cur = '';
    let quoted = false;
    for (const c of s) {
        if (c === '"') {
            quoted = !quoted;
            cur += c;
        } else if (c === delim && !quoted) {
            parts.push(cur);
            cur = '';
        } else {
            cur += c;
        }
    }
    parts.push(cur);
    return parts;
}

function stripQuotes(v: string): string {
    return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}

// Split into logical lines, unfolding continuations (RFC 2425 §5.8.1: a physical line starting with a
// single SPACE or TAB continues the previous one — drop the line break and that one whitespace char).
// Each line keeps `raw`, the exact source slice including its internal folding, so it re-emits verbatim.
function unfold(text: string): { raw: string; logical: string }[] {
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
    // Drop empty logical lines (blank physical lines, e.g. the trailing CRLF Outlook exports leave): they
    // carry no property and would otherwise reach parseLine without a colon. Byte-identity of a card with
    // blanks isn't preserved — the blanks simply don't round-trip.
    return lines.filter((l) => l.logical !== '').map((l) => ({ raw: text.slice(l.start, l.end), logical: l.logical }));
}

function parseLine(raw: string, logical: string): VCardLine {
    const colon = indexOfOutsideQuotes(logical, ':');
    if (colon === -1) throw new VCardError(`unparseable vCard line: ${logical}`);

    const segments = splitOutsideQuotes(logical.slice(0, colon), ';');
    const spec = segments[0];
    const dot = spec.indexOf('.');
    const group = dot === -1 ? null : spec.slice(0, dot);
    const name = (dot === -1 ? spec : spec.slice(dot + 1)).toUpperCase();

    const params: [string, string][] = [];
    for (let k = 1; k < segments.length; k++) {
        const seg = segments[k];
        const eq = seg.indexOf('=');
        if (eq === -1) params.push([seg.toUpperCase(), '']);
        else params.push([seg.slice(0, eq).toUpperCase(), stripQuotes(seg.slice(eq + 1))]);
    }

    return { group, name, params, value: logical.slice(colon + 1), raw };
}

// Exact envelope framing (RFC 6350 §6.1.1/6.1.2): BEGIN:VCARD is the first line, END:VCARD the last, one of
// each, nothing outside. A payload with a second card, a trailing END, or bytes around the envelope is
// rejected rather than stored and re-served to every DAV client.
export function parseVCardLines(text: string): VCardLine[] {
    const lines = unfold(text).map(({ raw, logical }) => parseLine(raw, logical));

    const frames = (name: string) => lines.filter((l) => l.name === name && l.value.toUpperCase() === 'VCARD');
    const begins = frames('BEGIN');
    const ends = frames('END');
    if (begins.length === 0) throw new VCardError('missing BEGIN:VCARD');
    if (ends.length === 0) throw new VCardError('missing END:VCARD');
    if (begins.length > 1) throw new VCardError('multiple vCards in one payload');
    if (ends.length > 1) throw new VCardError('multiple END:VCARD lines');
    if (begins[0] !== lines[0] || ends[0] !== lines[lines.length - 1]) {
        throw new VCardError('content outside the vCard envelope');
    }

    return lines;
}

// parseLine strips the surrounding quotes off a param value, so a rewritten line must re-quote it: a value
// with ';' ':' or ',' has to be double-quoted or it would truncate the param section / mint bogus params.
// vCard 3.0 has no quote-escape mechanism, so a literal quote or CR/LF is neutered first.
function buildParamValue(value: string): string {
    const clean = neuterParamValue(value);
    return /[;:,]/.test(clean) ? `"${clean}"` : clean;
}

function buildLine(line: VCardLine): string {
    let s = line.group ? `${line.group}.${line.name}` : line.name;
    for (const [name, value] of line.params) s += `;${name}=${buildParamValue(value)}`;
    return foldLine(`${s}:${line.value}`);
}

export function serializeVCardLines(lines: VCardLine[]): string {
    const out = lines.map((line) => (line.raw !== null ? line.raw : buildLine(line)));
    return `${out.join('\r\n')}\r\n`;
}

export function makeLine(
    name: string,
    value: string,
    params: [string, string][] = [],
    group: string | null = null,
): VCardLine {
    return {
        group,
        name: name.toUpperCase(),
        params: params.map(([n, v]): [string, string] => [n.toUpperCase(), v]),
        value,
        raw: null,
    };
}

// RFC 2426 §2.4.2 TEXT escaping — identical to iCal's, so the one implementation lives in core/content-line.
export { escapeContentText as escapeText } from '../core/content-line';

// One left-to-right pass so an escaped backslash (\\) can't recombine with the next char into a new
// escape. `\n`/`\N` become newline; every other `\x` drops the backslash.
export function unescapeText(v: string): string {
    return v.replace(/\\(.)/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

export function getVersion(lines: VCardLine[]): string | null {
    return lines.find((l) => l.name === 'VERSION')?.value ?? null;
}

// data:[<mediatype>];base64,<payload> — split a 4.0 inline-photo data: URI into its media type (null when
// none) and base64 payload. Returns null when it isn't a `;base64` data: URI (no comma, or no base64
// marker) so both the parser (-> photo: null) and the transcoder (-> VALUE=uri) can fall back cleanly.
export function splitDataUri(value: string): { mediaType: string | null; base64: string } | null {
    const comma = value.indexOf(',');
    if (comma === -1) return null;
    const header = value.slice('data:'.length, comma);
    if (!header.endsWith(';base64')) return null;
    return { mediaType: header.slice(0, -';base64'.length) || null, base64: value.slice(comma + 1) };
}
