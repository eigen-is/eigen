// The functions on text.

import { toText } from '../values/coerce';
import { define, SCALAR } from './registry';

export const TEXT = [
    define(
        'CONCATENATE',
        [SCALAR],
        (args) => {
            let joined = '';
            for (const arg of args) {
                const text = toText(arg);
                if (typeof text !== 'string') return text;
                joined += text;
            }
            return joined;
        },
        0,
        1,
    ),
];
