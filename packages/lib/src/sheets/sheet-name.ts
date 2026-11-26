// Excel's rule for a sheet name: not blank, a length limit, characters it refuses, and no quote at either end. Every
// place a name enters a workbook, such as a rename or a peer's op, holds it to this rule, so a name a formula prints
// reads back as the same sheet.

export const MAX_SHEET_NAME_LENGTH = 31;
const FORBIDDEN_CHARACTERS = ['\\', '/', '?', '*', '[', ']', ':'];
export const SHEET_NAME_FORBIDDEN = new RegExp(`[${FORBIDDEN_CHARACTERS.map((c) => `\\${c}`).join('')}]`, 'g');
export const SHEET_NAME_END_QUOTES = /^'+|'+$/g;
export const SHEET_NAME_RULE = `A sheet name has at most ${MAX_SHEET_NAME_LENGTH} characters, none of ${FORBIDDEN_CHARACTERS.join(' ')}, and no ' at either end`;

// `search` ignores the global pattern's lastIndex, which `test` would carry from one call into the next.
export function isSheetName(name: string): boolean {
    return (
        name.trim().length > 0 &&
        name.length <= MAX_SHEET_NAME_LENGTH &&
        name.search(SHEET_NAME_END_QUOTES) === -1 &&
        name.search(SHEET_NAME_FORBIDDEN) === -1
    );
}
