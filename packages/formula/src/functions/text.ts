// The functions on text. A number or a boolean among their arguments is spelled out first, and a position counts
// characters from 1. A count is refused for its sign before its fraction is cut: LEFT("abc",-0.9) is #VALUE!.
// VALUE reads a text as the number, date or time a person could have typed into a cell.

import { VALUE } from '../values/errors';
import { upperCase } from '../values/letter-case';
import { parseNumber } from '../values/parse-number';
import { LONGEST_TEXT } from '../values/value';
import { BOOLEAN, fn, NUMBER, optional, rest, TEXT, TEXTS } from './registry';

// Past this a position is no position: MID("abc",2^31,1) is #VALUE!.
const MOST = 2 ** 31;

// A text that would be too long is refused before it is built.
function concatenate(texts: readonly string[]) {
    let joined = '';
    for (const text of texts) {
        if (joined.length + text.length > LONGEST_TEXT) return VALUE;
        joined += text;
    }
    return joined;
}

export const TEXT_FUNCTIONS = [
    fn('CONCATENATE', [rest(TEXT)], concatenate),
    fn('CONCAT', [rest(TEXTS)], concatenate),
    // Between two texts goes the next delimiter, the first again after the last. With `skip`, empty text is left out.
    fn('TEXTJOIN', [TEXTS, BOOLEAN, rest(TEXTS)], (delimiters, skip, texts) => {
        let joined = '';
        let count = 0;
        for (const text of texts) {
            if (skip && text === '') continue;
            const delimiter = count === 0 ? '' : delimiters[(count - 1) % delimiters.length];
            if (joined.length + delimiter.length + text.length > LONGEST_TEXT) return VALUE;
            joined += delimiter + text;
            count += 1;
        }
        return joined;
    }),
    fn('LEFT', [TEXT, optional(NUMBER, 1)], (text, count) => (count < 0 ? VALUE : text.slice(0, Math.trunc(count)))),
    fn('MID', [TEXT, NUMBER, NUMBER], (text, start, count) => {
        if (start < 1 || count < 0 || start >= MOST || count >= MOST) return VALUE;
        const from = Math.trunc(start) - 1;
        return text.slice(from, from + Math.trunc(count));
    }),
    fn('REPLACE', [TEXT, NUMBER, NUMBER, TEXT], (text, start, count, put) => {
        if (start < 1 || count < 0) return VALUE;
        const from = Math.trunc(start) - 1;
        return text.slice(0, from) + put + text.slice(from + Math.trunc(count));
    }),
    fn('LEN', [TEXT], (text) => text.length),
    fn('VALUE', [TEXT], (text) => parseNumber(text) ?? VALUE),
    fn('UPPER', [TEXT], upperCase),
];
