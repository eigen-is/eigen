import { unfoldContentLines } from '@workspace/lib/content-line';
import { isEigenName } from './ical-parse';

// Spliced, not re-emitted: ical.js rewrites parameter quoting and order, and an indexed-only file is not Eigen's to rewrite.
export function spliceBlocks(ics: string, zones: Map<string, string[]>, events: string[][]): void {
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

        if (block[0] === 'BEGIN:VEVENT') {
            events.push(block);
        } else {
            // The first definition of a TZID wins: two resources naming one zone carry it once.
            const tzid = block.find((candidate) => candidate.startsWith('TZID:'))?.slice(5) ?? '';
            if (!zones.has(tzid)) zones.set(tzid, block);
        }
        block = null;
    }
}
