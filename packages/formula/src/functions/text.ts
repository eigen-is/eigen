// The functions on text. A number or a boolean among their arguments is spelled out first, and a position counts
// characters from 1. A count is refused for its sign before its fraction is cut: LEFT("abc",-0.9) is #VALUE!.

import { VALUE } from '../values/errors';
import { upperCase } from '../values/letter-case';
import { fn, NUMBER, optional, rest, TEXT } from './registry';

// Past this a position is no position: MID("abc",2^31,1) is #VALUE!.
const MOST = 2 ** 31;
// The most characters a text holds: a longer one is refused before it is built.
const LONGEST = 32767;

export const TEXT_FUNCTIONS = [
    fn('CONCATENATE', [rest(TEXT)], (texts) => {
        let joined = '';
        for (const text of texts) {
            if (joined.length + text.length > LONGEST) return VALUE;
            joined += text;
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
    fn('UPPER', [TEXT], upperCase),
];
