// Maps a parsed vCard (Task 2 AST) down to the projection the contact index stores and the CardDAV sync
// layer diffs against. Only the properties Eigen owns are extracted; the untouched AST rides along in
// `lines` so a write can merge edits back without disturbing properties we don't understand.
import type { Address } from '@workspace/lib/types/contact';
import { getVersion, parseVCardLines, splitDataUri, unescapeText, type VCardLine } from './vcard-ast';

export type ParsedCardPhoto =
    | { kind: 'inline'; bytes: Uint8Array; mediaType: string | null }
    | { kind: 'uri'; uri: string };

export type ParsedCard = {
    lines: VCardLine[];
    version: string | null;
    uid: string | null;
    firstName: string;
    lastName: string;
    email: string[];
    phone: string[];
    company: string;
    jobTitle: string;
    address: Address[];
    birthday: string; // normalized YYYY-MM-DD, or '' if absent/unparseable
    notes: string;
    categories: string[]; // unescaped names, comma-split
    eigenId: string | null; // X-EIGEN-ID value, verbatim
    isGroup: boolean; // KIND:group or X-ADDRESSBOOKSERVER-KIND:group
    photo: ParsedCardPhoto | null;
};

// Split a structured (';') or list (',') TEXT value on an unescaped delimiter, keeping the escape
// sequences intact so each component can be unescaped afterward. A backslash escapes the next character.
function splitValue(value: string, delim: string): string[] {
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

function firstParam(line: VCardLine, name: string): string | null {
    return line.params.find(([n]) => n === name)?.[1] ?? null;
}

// vCard 3.0 PHOTO TYPE is a bare image subtype ('JPEG'); a 4.0 data: URI already carries a full MIME.
function photoMediaType(type: string | null): string | null {
    if (!type) return null;
    return type.includes('/') ? type.toLowerCase() : `image/${type.toLowerCase()}`;
}

// Decode base64, tolerating any whitespace 3.0 folding left in the value. Returns null for a value that
// isn't valid base64 so a malformed PHOTO degrades to "no photo" rather than throwing.
function decodeBase64(value: string): Uint8Array | null {
    // Well-formed unfolded payloads skip the whitespace-strip, which allocates a full copy of a photo value.
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return Buffer.from(value, 'base64');
    const cleaned = value.replace(/\s/g, '');
    if (!cleaned || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return null;
    return Buffer.from(cleaned, 'base64');
}

// data:[<mediatype>];base64,<payload> — the 4.0 inline PHOTO form.
function decodeDataUri(value: string): ParsedCardPhoto | null {
    const split = splitDataUri(value);
    if (!split) return null;
    const bytes = decodeBase64(split.base64);
    return bytes ? { kind: 'inline', bytes, mediaType: split.mediaType } : null;
}

function parsePhoto(line: VCardLine): ParsedCardPhoto | null {
    if (line.value.startsWith('data:')) return decodeDataUri(line.value);
    if (firstParam(line, 'ENCODING')?.toLowerCase() === 'b') {
        const bytes = decodeBase64(line.value);
        return bytes ? { kind: 'inline', bytes, mediaType: photoMediaType(firstParam(line, 'TYPE')) } : null;
    }
    return { kind: 'uri', uri: line.value };
}

// BDAY normalized to YYYY-MM-DD; '' for the 4.0 year-less '--MMDD' form or anything unparseable. Also the
// seam the Contacts writers run incoming birthdays through, so it accepts the app's ISO datetime
// ('1990-01-01T00:00:00.000Z') and keeps just its date prefix when the whole value is a valid ISO datetime.
export function normalizeBirthday(value: string): string {
    const v = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const compact = v.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
    if (/^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))) return v.slice(0, 10);
    return '';
}

export function parseVCard(text: string): ParsedCard {
    const lines = parseVCardLines(text);
    const first = (name: string) => lines.find((l) => l.name === name);
    const values = (name: string) =>
        lines
            .filter((l) => l.name === name)
            .map((l) => unescapeText(l.value).trim())
            .filter((v) => v !== '');

    // Prefer the structured N (Family;Given;…); fall back to splitting FN like addYourself does.
    let firstName = '';
    let lastName = '';
    const n = first('N');
    if (n) {
        const c = splitValue(n.value, ';').map(unescapeText);
        lastName = c[0] ?? '';
        firstName = c[1] ?? '';
    } else {
        const fn = first('FN');
        if (fn) {
            const parts = unescapeText(fn.value).split(' ');
            firstName = parts[0] || '';
            lastName = parts.slice(1).join(' ');
        }
    }

    const address = lines
        .filter((l) => l.name === 'ADR')
        .map((l) => {
            // PO;ext;street;locality;region;code;country — empty components are dropped.
            const c = splitValue(l.value, ';').map(unescapeText);
            const addr: Address = {};
            if (c[2]) addr.street = c[2];
            if (c[3]) addr.city = c[3];
            if (c[4]) addr.state = c[4];
            if (c[5]) addr.zipCode = c[5];
            if (c[6]) addr.country = c[6];
            return addr;
        });

    // Aggregate every CATEGORIES line (external clients legitimately split labels across several); membership
    // resolves by normalized name downstream, which dedupes, so order-preserving concat with no dedupe is fine.
    const categories = lines
        .filter((l) => l.name === 'CATEGORIES')
        .flatMap((l) => (l.value ? splitValue(l.value, ',').map(unescapeText) : []));
    const kind = first('KIND') ?? first('X-ADDRESSBOOKSERVER-KIND');
    const photo = first('PHOTO');

    return {
        lines,
        version: getVersion(lines),
        uid: first('UID')?.value ?? null,
        firstName,
        lastName,
        email: values('EMAIL'),
        phone: values('TEL'),
        company: unescapeText(splitValue(first('ORG')?.value ?? '', ';')[0] ?? ''),
        jobTitle: unescapeText(first('TITLE')?.value ?? ''),
        address,
        birthday: normalizeBirthday(first('BDAY')?.value ?? ''),
        notes: unescapeText(first('NOTE')?.value ?? ''),
        categories,
        eigenId: first('X-EIGEN-ID')?.value ?? null,
        isGroup: kind?.value.trim().toLowerCase() === 'group',
        photo: photo ? parsePhoto(photo) : null,
    };
}
