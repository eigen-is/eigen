// A number read from a text whose decimal and group separators the caller names, as NUMBERVALUE does: "1.234,5"
// with a comma for decimals is 1234.5. A space, a tab and a line break are passed over anywhere, and the group
// separator only left of the decimal point: "1.000,5" read with a point for decimals is no number. Every percent
// sign at the end divides by 100, and brackets around an unsigned number make it negative. It reads no date and no
// time.

import { countCharacters, cutCharacters } from './characters';

// An opening bracket, a sign, a dollar sign, digits with a point somewhere and an exponent, a closing bracket,
// percent signs.
const SHAPE = /^(\(?)([+-]?)\$?((?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(\)?)(%*)$/i;

// Nothing but percent signs is 0, as an empty text is.
const NOTHING = /^%*$/;

// `decimal` and `group` are one character each, and `group` is empty when nothing groups.
export function separatedNumber(text: string, decimal: string, group: string): number | undefined {
    let plain = '';
    let pointed = false;
    const count = countCharacters(text);
    for (let at = 0; at < count; at += 1) {
        const character = cutCharacters(text, at, 1);
        if (character === ' ' || character === '\t' || character === '\n') continue;
        if (character === group) {
            if (pointed) return undefined;
            continue;
        }
        pointed ||= character === decimal || character === '.';
        plain += character === decimal ? '.' : character;
    }
    const match = SHAPE.exec(plain);
    if (match === null) return NOTHING.test(plain) ? 0 : undefined;
    const [, open, sign, digits, close, percents] = match;
    if ((open === '') !== (close === '') || (open !== '' && sign !== '')) return undefined;
    const value = Number(digits) / 100 ** countCharacters(percents);
    if (!Number.isFinite(value)) return undefined;
    return open !== '' || sign === '-' ? -value : value;
}
