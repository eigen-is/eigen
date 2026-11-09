// Lifts the VTIMEZONE and VEVENT blocks of a stored file as text, for an export to join them into one VCALENDAR.
// Spliced, not re-emitted, because ical.js rewrites parameter quoting and order, and an indexed-only file is not Eigen's
// to rewrite. Only a file whose zone means something else than the export's first definition of that name is rewritten.

import { normalizeTimezone } from '@workspace/lib/calendar/calendar-utils';
import { unfoldContentLines } from '@workspace/lib/content-line';
import { isEigenName, parseResource } from './ical-parse';

export function spliceBlocks(ics: string, zones: Map<string, string[]>, events: string[][]): void {
    const blocks = liftBlocks(ics);
    if (blocks.some((block) => clashes(block, zones))) {
        spliceBlocks(withOwnZoneNames(ics), zones, events);
        return;
    }
    for (const block of blocks) {
        if (block[0] === 'BEGIN:VEVENT') events.push(block);
        // Two resources naming one zone carry it once.
        else if (!zones.has(zoneName(block))) zones.set(zoneName(block), block);
    }
}

function liftBlocks(ics: string): string[][] {
    const blocks: string[][] = [];
    let block: string[] | null = null;
    let depth = 0;
    for (const line of unfoldContentLines(ics)) {
        // Whatever the file folded with, the blocks are re-emitted into a CRLF one.
        const text = line.raw.replace(/\r?\n/g, '\r\n');
        if (!block) {
            if (text === 'BEGIN:VTIMEZONE' || text === 'BEGIN:VEVENT') {
                block = [text];
                depth = 1;
            }
            continue;
        }
        if (text.startsWith('BEGIN:')) depth++;
        else if (text.startsWith('END:')) depth--;
        const end = line.logical.search(/[;:]/);
        if (!isEigenName((end === -1 ? line.logical : line.logical.slice(0, end)).toLowerCase())) block.push(text);
        if (depth > 0) continue;

        blocks.push(block);
        block = null;
    }
    return blocks;
}

function zoneName(block: readonly string[]): string {
    return block.find((candidate) => candidate.startsWith('TZID:'))?.slice(5) ?? '';
}

// An IANA name resolves through Intl however a file defines it, so only a name the file alone explains can clash, such
// as Outlook's "Customized Time Zone".
function clashes(block: readonly string[], zones: ReadonlyMap<string, string[]>): boolean {
    if (block[0] !== 'BEGIN:VTIMEZONE') return false;
    const held = zones.get(zoneName(block));
    return !!held && held.join() !== block.join() && !normalizeTimezone(zoneName(block));
}

// The name carries a digest of the definition, so another file with the same one lands on the same name.
function withOwnZoneNames(ics: string): string {
    const resource = parseResource(ics);
    const names = new Map<string, string>();
    for (const zone of resource.getAllSubcomponents('vtimezone')) {
        const tzid = String(zone.getFirstPropertyValue('tzid'));
        if (normalizeTimezone(tzid)) continue;
        const digest = new Bun.CryptoHasher('sha256').update(zone.toString()).digest('hex');
        const name = `${tzid} ${digest.slice(0, 8)}`;
        names.set(tzid, name);
        zone.updatePropertyWithValue('tzid', name);
    }
    for (const vevent of resource.getAllSubcomponents('vevent')) {
        for (const prop of vevent.getAllProperties()) {
            const name = names.get(String(prop.getFirstParameter('tzid')));
            if (name) prop.setParameter('tzid', name);
        }
    }
    return resource.toString();
}
