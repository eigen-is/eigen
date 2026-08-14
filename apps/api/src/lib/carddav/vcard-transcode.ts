// vCard 4.0 -> 3.0 transcode applied at the CardDAV PUT seam (Task 13's putCard). The book is 3.0 on disk
// and on the wire, but Thunderbird 102+ PUTs VERSION:4.0 regardless of what the server advertises, and 4.0
// bytes served verbatim lose the photo on iOS (which reads only the 3.0 PHOTO;ENCODING=b form). So a 4.0
// card is rewritten before storage: only VERSION and PHOTO are rebuilt — every other property, including
// 4.0-only params like PID/ALTID/LABEL, rides through verbatim. Any non-4.0 card is returned unchanged.
import { getVersion, makeLine, parseVCardLines, serializeVCardLines } from './vcard-ast';
import { photoParams } from './vcard-serialize';

export function transcodeTo30(text: string): string {
    const lines = parseVCardLines(text);
    if (getVersion(lines) !== '4.0') return text;

    const rewritten = lines.map((line) => {
        if (line.name === 'VERSION') return makeLine('VERSION', '3.0');
        if (line.name !== 'PHOTO') return line;
        // 4.0 inline photos are data: URIs, remote ones bare/MEDIATYPE URIs. Rewrite to the 3.0 ENCODING=b
        // / VALUE=uri form, keeping the group; a data: URI's base64 payload rides across untouched.
        if (line.value.startsWith('data:')) {
            const comma = line.value.indexOf(',');
            const mediaType = line.value.slice('data:'.length, comma).replace(/;base64$/, '');
            return makeLine('PHOTO', line.value.slice(comma + 1), photoParams(mediaType), line.group);
        }
        return makeLine('PHOTO', line.value, [['VALUE', 'uri']], line.group);
    });
    return serializeVCardLines(rewritten);
}
