// The Windows code page CHAR and CODE count in: a code from 1 to 255, of which 128 to 159 are characters from all
// over Unicode, such as the euro sign at 128. A character the page does not hold has no code, and CODE answers the
// code of a question mark for it.

// The characters at 128 to 159. The five the page leaves open stand for the control character of their own code.
const HIGH = [
    0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
    0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e,
    0x178,
];

const QUESTION = 63;

export function ansiCharacter(code: number): string {
    return String.fromCharCode(HIGH[code - 128] ?? code);
}

// Takes the Unicode code point of a character.
export function ansiCode(point: number): number {
    if (point < 128 || (point >= 160 && point < 256)) return point;
    const at = HIGH.indexOf(point);
    return at < 0 ? QUESTION : at + 128;
}
