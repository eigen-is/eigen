// vCard 4.0 -> 3.0 transcode applied at the CardDAV PUT seam (Task 13's putCard). The book is 3.0 on disk
// and on the wire, but Thunderbird 102+ PUTs VERSION:4.0 regardless of what the server advertises, and 4.0
// bytes served verbatim lose the photo on iOS (which reads only the 3.0 PHOTO;ENCODING=b form). So a 4.0
// card is rewritten before storage: only VERSION and PHOTO are rebuilt — every other property, including
// 4.0-only params like PID/ALTID/LABEL, rides through verbatim. Any non-4.0 card is returned unchanged.
import { getVersion, makeLine, parseVCardLines, serializeVCardLines, splitDataUri } from './vcard-ast';
import { photoParams } from './vcard-serialize';

export function transcodeTo30(text: string): string {
    // VERSION must come right after BEGIN:VCARD (RFC 2426 §2.1.1 / RFC 6350 §6.7.9). When the head reads
    // that shape unfolded — every real client — a non-4.0 card returns without the full parse, which would
    // otherwise unfold a multi-MiB PHOTO payload just to be discarded. Anything else (PRODID-first,
    // pathological folding) falls through to the exact path below.
    const head = /^BEGIN:VCARD\r?\nVERSION:([^\r\n]+)\r?\n[^ \t]/.exec(text.slice(0, 64));
    if (head && head[1].trim() !== '4.0') return text;

    const lines = parseVCardLines(text);
    if (getVersion(lines) !== '4.0') return text;

    const rewritten = lines.map((line) => {
        if (line.name === 'VERSION') return makeLine('VERSION', '3.0');
        if (line.name !== 'PHOTO') return line;
        // 4.0 inline photos are data: URIs, remote ones bare/MEDIATYPE URIs. Rewrite to the 3.0 ENCODING=b
        // / VALUE=uri form, keeping the group; a data: URI's base64 payload rides across untouched. A
        // malformed (comma-less) data: value is still a URI-shaped value, so it falls through to VALUE=uri.
        if (line.value.startsWith('data:')) {
            const dataUri = splitDataUri(line.value);
            if (dataUri) {
                return makeLine('PHOTO', dataUri.base64, photoParams(dataUri.mediaType ?? ''), line.group);
            }
        }
        return makeLine('PHOTO', line.value, [['VALUE', 'uri']], line.group);
    });
    return serializeVCardLines(rewritten);
}
