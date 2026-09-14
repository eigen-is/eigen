// Maps a parsed vCard AST down to the projection the contact index stores and the CardDAV sync
// layer diffs against. Only the properties Eigen owns are extracted; the untouched AST rides along in
// `lines` so a write can merge edits back without disturbing properties we don't understand.
import type { Address } from '@workspace/lib/types/contact';
import { getVersion, parseVCardLines, splitDataUri, splitValue, unescapeText } from './ast';
import type { ParsedCard, ParsedCardPhoto, VCardLine } from './types';

function firstParam(line: VCardLine, name: string): string | null {
    return line.params.find(([n]) => n === name)?.[1] ?? null;
}

// vCard 3.0 PHOTO TYPE is a bare image subtype ('JPEG'); a 4.0 data: URI already carries a full MIME.
function photoMediaType(type: string | null): string | null {
    if (!type) return null;
    return type.includes('/') ? type.toLowerCase() : `image/${type.toLowerCase()}`;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// Decode base64, tolerating any whitespace 3.0 folding left in the value. The regex is what decides:
// Buffer decodes leniently, so a value it is not handed as base64 has to be refused here, keeping a
// malformed PHOTO a "no photo" rather than a throw. A truncated payload still yields the bytes it carried.
function decodeBase64(value: string): Uint8Array | null {
    // Well-formed unfolded payloads skip the whitespace-strip, which allocates a full copy of a photo value.
    if (BASE64.test(value)) return new Uint8Array(Buffer.from(value, 'base64'));
    const cleaned = value.replace(/\s/g, '');
    if (!cleaned || !BASE64.test(cleaned)) return null;
    return new Uint8Array(Buffer.from(cleaned, 'base64'));
}

function parsePhoto(line: VCardLine): ParsedCardPhoto | null {
    if (line.value.startsWith('data:')) {
        const split = splitDataUri(line.value);
        if (!split) return null;
        const bytes = decodeBase64(split.base64);
        return bytes ? { kind: 'inline', bytes, mediaType: split.mediaType } : null;
    }
    if (firstParam(line, 'ENCODING')?.toLowerCase() === 'b') {
        const bytes = decodeBase64(line.value);
        return bytes ? { kind: 'inline', bytes, mediaType: photoMediaType(firstParam(line, 'TYPE')) } : null;
    }
    return { kind: 'uri', uri: line.value };
}

// The only BDAY form Eigen stores: what normalizeBirthday produces, and the serializer's write guard.
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// BDAY normalized to YYYY-MM-DD; '' for the 4.0 year-less '--MMDD' form or anything unparseable. Also the
// seam the Contacts writers run incoming birthdays through, so it accepts the app's ISO datetime
// ('1990-01-01T00:00:00.000Z') and keeps just its date prefix when the whole value is a valid ISO datetime.
export function normalizeBirthday(value: string): string {
    const v = value.trim();
    if (ISO_DATE.test(v)) return v;
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
