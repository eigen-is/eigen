// Sheet names as a formula spells them: when a name may stand bare before the ! and how it is quoted otherwise, the
// key two names are compared by, and the sheet a typed name reads. The parser resolves names through these and the
// A1 printer writes them, as does anything else that builds a reference to another sheet.

const BARE_CHARACTERS = /^[\p{L}\p{N}_.]+$/u;
const MISREAD_BARE = /^(?:[\d.].*|[A-Z]{1,3}\d+|R\d*C\d*|[RC]|TRUE|FALSE)$/i;

// Whether the name reads as itself without quotes. An allow-list: letters, digits, _ and ., and not what the
// grammar reads as a number, a cell in either notation or a boolean.
export function isBareSheetName(name: string): boolean {
    return BARE_CHARACTERS.test(name) && !MISREAD_BARE.test(name);
}

export function quotedSheetName(name: string): string {
    return `'${name.replaceAll("'", "''")}'`;
}

// The name as a reference's sheet prefix spells it: bare where that reads back as the name, quoted otherwise.
export function quoteSheetName(name: string): string {
    return isBareSheetName(name) ? name : quotedSheetName(name);
}

// What two sheet names are compared by. Each character folds to its uppercase on its own, so the Greek final ς
// matches σ, and one whose uppercase is longer keeps its case, so ß never matches ss.
export function sheetNameKey(name: string): string {
    const upper = name.toUpperCase();
    if (upper.length === name.length) return upper;
    let key = '';
    for (const char of name) {
        const folded = char.toUpperCase();
        key += folded.length === char.length ? folded : char;
    }
    return key;
}

// The sheet a name reads: the one of exactly that name, else one in another case. A workbook can hold Data and
// data, and then each name keeps reading its own sheet.
export function findSheetByName<S extends { readonly name: string }>(
    sheets: readonly S[],
    name: string,
): S | undefined {
    const exact = sheets.find((sheet) => sheet.name === name);
    if (exact) return exact;
    const key = sheetNameKey(name);
    return sheets.find((sheet) => sheetNameKey(sheet.name) === key);
}

// findSheetByName through maps built once, for a walk that reads many names, such as parsing every formula of a
// workbook.
export function sheetFinder<S extends { readonly name: string }>(
    sheets: readonly S[],
): (name: string) => S | undefined {
    const byName = new Map<string, S>();
    const byKey = new Map<string, S>();
    for (const sheet of sheets) {
        if (!byName.has(sheet.name)) byName.set(sheet.name, sheet);
        const key = sheetNameKey(sheet.name);
        if (!byKey.has(key)) byKey.set(key, sheet);
    }
    return (name) => byName.get(name) ?? byKey.get(sheetNameKey(name));
}
