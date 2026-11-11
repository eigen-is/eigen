// The functions on text. Each reads its arguments as text and as whole numbers through the coercers, so a number
// or a boolean is spelled out first, and a position counts characters from 1.

import { VALUE } from '../values/errors';
import { define, INTEGER, optional, refusal, SCALAR, scalar1, scalar2, scalar3, scalar4, TEXT } from './registry';

export const TEXT_FUNCTIONS = [
    define(
        'CONCATENATE',
        [SCALAR],
        (args) => {
            let joined = '';
            for (const arg of args) {
                const text = TEXT.read(arg);
                if (text === undefined) return refusal(arg);
                joined += text;
            }
            return joined;
        },
        0,
        1,
    ),
    scalar2('LEFT', TEXT, optional(INTEGER, 1), (text, count) => (count < 0 ? VALUE : text.slice(0, count))),
    scalar3('MID', TEXT, INTEGER, INTEGER, (text, start, count) =>
        start < 1 || count < 0 ? VALUE : text.slice(start - 1, start - 1 + count),
    ),
    scalar4('REPLACE', TEXT, INTEGER, INTEGER, TEXT, (text, start, count, put) =>
        start < 1 || count < 0 ? VALUE : text.slice(0, start - 1) + put + text.slice(start - 1 + count),
    ),
    scalar1('LEN', TEXT, (text) => text.length),
    scalar1('UPPER', TEXT, (text) => text.toUpperCase()),
];
