// A number read from a text whose decimal and group separators the caller names, as NUMBERVALUE does: "1.234,5"
// with a comma for decimals is 1234.5. Blank space anywhere and the group separator are passed over, every percent
// sign at the end divides by 100, and brackets around it make it negative. It reads no date and no time.

const PERCENT = 37;
const OPEN = 40;
const CLOSE = 41;

// A sign, a dollar sign, digits with a point somewhere, an exponent.
const SHAPE = /^[+-]?\$?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

// `decimal` and `group` are one character each, and `group` is empty when nothing groups.
export function separatedNumber(text: string, decimal: string, group: string): number | undefined {
    let plain = '';
    for (const character of text) {
        if (character !== group && character.trim() !== '') plain += character === decimal ? '.' : character;
    }
    if (plain === '') return 0;
    let end = plain.length;
    while (plain.charCodeAt(end - 1) === PERCENT) end -= 1;
    const bracketed = plain.charCodeAt(0) === OPEN && plain.charCodeAt(end - 1) === CLOSE;
    const match = SHAPE.exec(bracketed ? plain.slice(1, end - 1) : plain.slice(0, end));
    if (match === null) return undefined;
    const value = Number(match[0].replace('$', '')) / 100 ** (plain.length - end);
    if (!Number.isFinite(value)) return undefined;
    return bracketed ? -value : value;
}
