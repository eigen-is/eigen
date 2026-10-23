import type { InlineStringSegment } from '@workspace/lib/sheets';
import { escapeXml } from '@workspace/lib/xml';
import type { CountedWarningCode } from '../../../document/transform/protocol';
import { SML_NS } from '../../../ooxml/ooxml';
import { encodeEscapes, MAX_TEXT_LENGTH } from '../../../ooxml/spreadsheetml';
import { runPropertiesXml } from './styles';

// The shared strings, each interned once as the sheets are written, then written after them. A plain string is keyed
// by the text the sheet already holds; a rich one by its runs' XML.
export type SharedStringTable = {
    text(value: string): number;
    // Undefined when no run has text.
    runs(segments: InlineStringSegment[]): number | undefined;
    xml(): Iterable<string>;
};

export const BATCH_CHARS = 1024 * 1024;

export function sharedStringTable(lost: (code: CountedWarningCode) => void): SharedStringTable {
    const plain = new Map<string, number>();
    const rich = new Map<string, number>();
    // By index: a plain string's text, a rich one's runs.
    const items: (string | { runs: string })[] = [];
    let count = 0;
    const intern = (map: Map<string, number>, key: string, item: string | { runs: string }) => {
        count++;
        let index = map.get(key);
        if (index === undefined) {
            index = items.length;
            map.set(key, index);
            items.push(item);
        }
        return index;
    };
    return {
        text(value) {
            const text = cutText(value, lost);
            return intern(plain, text, text);
        },
        runs(segments) {
            const runs = segments
                .filter((segment) => segment.v)
                .map((segment) => `<r>${runPropertiesXml(segment)}${textXml(segment.v ?? '')}</r>`)
                .join('');
            return runs ? intern(rich, runs, { runs }) : undefined;
        },
        *xml() {
            let batch = `<sst xmlns="${SML_NS}" count="${count}" uniqueCount="${items.length}">`;
            for (const item of items) {
                batch += `<si>${typeof item === 'string' ? textXml(item) : item.runs}</si>`;
                if (batch.length >= BATCH_CHARS) {
                    yield batch;
                    batch = '';
                }
            }
            yield `${batch}</sst>`;
        },
    };
}

// Past Excel's limit a cell's text is cut.
export function cutText(text: string, lost: (code: CountedWarningCode) => void): string {
    if (text.length <= MAX_TEXT_LENGTH) return text;
    lost('texts-cut');
    return text.slice(0, MAX_TEXT_LENGTH);
}

// XML collapses no whitespace, but Excel trims a text's edges unless told.
function textXml(text: string): string {
    const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
    return `<t${space}>${escapeXml(encodeEscapes(text))}</t>`;
}
