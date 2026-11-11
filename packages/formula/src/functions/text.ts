// The functions on text. A number or a boolean among their arguments is spelled out first, and a position counts
// characters from 1. A count is refused for its sign before its fraction is cut: LEFT("abc",-0.9) is #VALUE!.

import { VALUE } from '../values/errors';
import { upperCase } from '../values/letter-case';
import { define, TEXT as OLD_TEXT, refusal, SCALAR } from './legacy';
import { fn, NUMBER, optional, TEXT } from './registry';

// Past this a position is no position: MID("abc",2^31,1) is #VALUE!.
const MOST = 2 ** 31;

export const TEXT_FUNCTIONS = [
    define(
        'CONCATENATE',
        [SCALAR],
        (args) => {
            let joined = '';
            for (const arg of args) {
                const text = OLD_TEXT.read(arg);
                if (text === undefined) return refusal(arg);
                joined += text;
            }
            return joined;
        },
        0,
        1,
    ),
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
