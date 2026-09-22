// Partial address-data (RFC 6352 § 10.4.2): projects through the content-line AST so kept lines keep their source bytes.
import { parseVCardLines, serializeVCardLines } from '../vcard';
import type { VCardLine } from '../vcard/types';

// RFC 6352 § 10.4.2 requires VERSION+UID in any returned card; BEGIN/END/FN/N keep the projection a usable vCard.
const SKELETON = new Set(['BEGIN', 'END', 'VERSION', 'UID', 'FN', 'N']);

export function projectAddressData(text: string, propNames: string[]): string {
    const wanted = new Set(propNames.map((n) => n.toUpperCase()));
    const lines = parseVCardLines(text);
    const keep = (l: VCardLine): boolean => wanted.has(l.name) || SKELETON.has(l.name);

    // A group's X- label rides along only while a non-X line of that group survives, so no label is left dangling.
    const anchoredGroups = new Set<string>();
    for (const l of lines) if (l.group && !l.name.startsWith('X-') && keep(l)) anchoredGroups.add(l.group);

    const kept = lines.filter(
        (l) => keep(l) || (l.group !== null && l.name.startsWith('X-') && anchoredGroups.has(l.group)),
    );
    return serializeVCardLines(kept);
}
