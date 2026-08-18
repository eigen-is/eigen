// vCard 4.0 -> 3.0 transcode for the CardDAV PUT seam (Contacts.putCard runs every PUT body through it before
// storage). The book is 3.0 on disk and on the wire, but Thunderbird 102+ PUTs VERSION:4.0
// regardless of what the server advertises, and 4.0 bytes served verbatim lose the photo on iOS (which reads
// only the 3.0 PHOTO;ENCODING=b form). So a 4.0 card is rewritten before storage: VERSION, PHOTO, tel: URI
// TEL values, ISO-basic BDAY dates and numeric PREF get their real 3.0 form; every construct with no 3.0
// equivalent (ANNIVERSARY, KIND, PID/ALTID params, …) rides through verbatim rather than failing the card.
// Any non-4.0 card is returned unchanged.
import { getVersion, makeLine, parseVCardLines, serializeVCardLines, splitDataUri, type VCardLine } from './vcard-ast';
import { normalizeBirthday } from './vcard-parse';
import { photoParams } from './vcard-serialize';

// 4.0 spells preference as PREF=<1..100> on any property, lowest wins (RFC 6350 §5.3); 3.0 has only TYPE=PREF
// and no ordering, so exactly one line per property name can carry it.
function pickPreferred(lines: VCardLine[]): Set<VCardLine> {
    const best = new Map<string, { line: VCardLine; rank: number }>();
    for (const line of lines) {
        const pref = line.params.find(([n]) => n === 'PREF');
        if (!pref) continue;
        const rank = Number(pref[1]);
        if (Number.isNaN(rank)) continue;
        const current = best.get(line.name);
        if (!current || rank < current.rank) best.set(line.name, { line, rank });
    }
    return new Set([...best.values()].map((b) => b.line));
}

function to30(line: VCardLine, preferred: Set<VCardLine>): VCardLine {
    if (line.name === 'VERSION') return makeLine('VERSION', '3.0');
    if (line.name === 'PHOTO') {
        // 4.0 inline photos are data: URIs, remote ones bare/MEDIATYPE URIs. Rewrite to the 3.0 ENCODING=b /
        // VALUE=uri form, keeping the group; a data: URI's base64 payload rides across untouched. A
        // malformed (comma-less) data: value is still a URI-shaped value, so it falls through to VALUE=uri.
        if (line.value.startsWith('data:')) {
            const dataUri = splitDataUri(line.value);
            if (dataUri) return makeLine('PHOTO', dataUri.base64, photoParams(dataUri.mediaType ?? ''), line.group);
        }
        return makeLine('PHOTO', line.value, [['VALUE', 'uri']], line.group);
    }

    let params: [string, string][] = line.params;
    let value = line.value;
    // RFC 2426 defines TEL as a phone number, not a URI: unwrap the tel: scheme 4.0 wraps it in and drop the
    // VALUE=uri that announced it. Any other scheme (sip:, skype:) has no 3.0 form and stays as it came.
    if (line.name === 'TEL' && value.toLowerCase().startsWith('tel:')) {
        value = value.slice('tel:'.length);
        params = params.filter(([n]) => n !== 'VALUE');
    }
    // 4.0 writes ISO-basic dates (19061209), 3.0 the extended form. The year-less --1209 form and VALUE=text
    // birthdays have no 3.0 equivalent, and normalizeBirthday reads neither, so they ride through.
    if (line.name === 'BDAY') value = normalizeBirthday(value) || value;
    if (params.some(([n]) => n === 'PREF')) {
        params = params.filter(([n]) => n !== 'PREF');
        if (preferred.has(line)) params = [...params, ['TYPE', 'PREF']];
    }
    return params === line.params && value === line.value ? line : makeLine(line.name, value, params, line.group);
}

export function transcodeTo30(text: string): string {
    // VERSION must come right after BEGIN:VCARD (RFC 2426 §2.1.1 / RFC 6350 §6.7.9). When the head reads
    // that shape unfolded — every real client — a non-4.0 card returns without the full parse, which would
    // otherwise unfold a multi-MiB PHOTO payload just to be discarded. Anything else (PRODID-first,
    // pathological folding) falls through to the exact path below.
    const head = /^BEGIN:VCARD\r?\nVERSION:([^\r\n]+)\r?\n[^ \t]/.exec(text.slice(0, 64));
    if (head && head[1].trim() !== '4.0') return text;

    const lines = parseVCardLines(text);
    if (getVersion(lines) !== '4.0') return text;

    const preferred = pickPreferred(lines);
    return serializeVCardLines(lines.map((line) => to30(line, preferred)));
}
