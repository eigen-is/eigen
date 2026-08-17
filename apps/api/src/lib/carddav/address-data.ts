// CardDAV partial address-data retrieval (RFC 6352 § 10.4.2): a REPORT may ask for a subset of a card's
// properties via <CARD:address-data><CARD:prop name="…"/>…</CARD:address-data>. This projects a stored vCard
// down to that subset, re-serializing through the content-line AST so every kept line keeps its exact source
// bytes (folding included) — the byte-identity contract still holds for the properties that survive.
import { parseVCardLines, serializeVCardLines, type VCardLine } from './vcard-ast';

// Kept in every projection regardless of the requested subset: RFC 6352 § 10.4.2 requires VERSION+UID in any
// returned card, BEGIN/END frame the envelope, and FN/N make the result a usable vCard.
// Names are uppercase to match the AST's uppercased VCardLine.name.
const SKELETON = new Set(['BEGIN', 'END', 'VERSION', 'UID', 'FN', 'N']);

export function projectAddressData(text: string, propNames: string[]): string {
    const wanted = new Set(propNames.map((n) => n.toUpperCase()));
    const lines = parseVCardLines(text);
    const keep = (l: VCardLine): boolean => wanted.has(l.name) || SKELETON.has(l.name);

    // A kept grouped property keeps its same-group X- label (item1.EMAIL keeps item1.X-ABLabel). This is the
    // inverse of vcard-serialize.ts dropping an orphaned label when its anchor property is removed: a group's
    // X- lines ride along only while a non-X line in that group survives the projection, so a label whose
    // anchor wasn't requested is dropped rather than left dangling.
    const anchoredGroups = new Set<string>();
    for (const l of lines) if (l.group && !l.name.startsWith('X-') && keep(l)) anchoredGroups.add(l.group);

    const kept = lines.filter(
        (l) => keep(l) || (l.group !== null && l.name.startsWith('X-') && anchoredGroups.has(l.group)),
    );
    return serializeVCardLines(kept);
}
