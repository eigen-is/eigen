// vCard content-line AST (RFC 6350 §3): an unrewritten line keeps its source bytes, so a card round-trips byte-for-byte.
import { foldLine, isIllegalC0, neuterParamValue, unfoldContentLines } from '@workspace/lib/content-line';
import type { VCardLine } from './types';

export class VCardError extends Error {}

function indexOfOutsideQuotes(s: string, ch: string): number {
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '"') quoted = !quoted;
        else if (c === ch && !quoted) return i;
    }
    return -1;
}

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

// RFC 6350 §6.1.1/6.1.2 framing: a payload with a second card or bytes outside the envelope is rejected, not stored.
export function parseVCardLines(text: string): VCardLine[] {
    // One stored C0 byte would invalidate every full-book REPORT, and an ingest parse must not silently alter client bytes.
    for (let i = 0; i < text.length; i++) {
        if (isIllegalC0(text.charCodeAt(i))) throw new VCardError('control character in vCard');
    }

    const lines = unfoldContentLines(text).map(({ raw, logical }) => parseLine(raw, logical));

    // trimEnd only, mirroring splitVCards: a card a PUT accepts must re-import from its own export
    const frames = (name: string) =>
        lines.filter((l) => l.name === name && l.value.trimEnd().toUpperCase() === 'VCARD');
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

// A param value holding ';' ':' or ',' must be re-quoted or it mints bogus params; vCard 3.0 has no quote escape.
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

// Escape sequences stay intact, so joining the parts back on the delimiter restores the exact source bytes.
export function splitValue(value: string, delim: string): string[] {
    const parts: string[] = [];
    let cur = '';
    for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (c === '\\' && i + 1 < value.length) {
            cur += c + value[i + 1];
            i++;
        } else if (c === delim) {
            parts.push(cur);
            cur = '';
        } else {
            cur += c;
        }
    }
    parts.push(cur);
    return parts;
}

// One left-to-right pass, so an escaped backslash cannot recombine with the next char into a new escape.
export function unescapeText(v: string): string {
    return v.replace(/\\(.)/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

export function getVersion(lines: VCardLine[]): string | null {
    return lines.find((l) => l.name === 'VERSION')?.value ?? null;
}

// Null when the value is not a `;base64` data: URI, so the parser and the photo transcoder can both fall back.
export function splitDataUri(value: string): { mediaType: string | null; base64: string } | null {
    const comma = value.indexOf(',');
    if (comma === -1) return null;
    const header = value.slice('data:'.length, comma);
    if (!header.endsWith(';base64')) return null;
    return { mediaType: header.slice(0, -';base64'.length) || null, base64: value.slice(comma + 1) };
}

// vCard 3.0 PHOTO TYPE is the bare, uppercased image subtype ('image/jpeg' -> 'JPEG').
export function photoParams(mediaType: string): [string, string][] {
    const subtype = mediaType.split('/')[1] ?? mediaType;
    return [
        ['ENCODING', 'b'],
        ['TYPE', subtype.toUpperCase()],
    ];
}
