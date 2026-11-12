// Sheet names as a formula spells them: when a name may stand bare before the ! and how it is quoted otherwise, the
// key two names are compared by, and the sheet a typed name reads. The parser resolves names through these and the
// A1 printer writes them, as does anything else that builds a reference to another sheet.

import { upperCase } from '../values/letter-case';
import { isWord } from './lexer';
import { readsAsReference } from './parser';

const NEVER_BARE = /[?\\]|^(?:TRUE|FALSE)$/i;

export function quotedSheetName(name: string): string {
    return `'${name.replaceAll("'", "''")}'`;
}

// The name as a reference's sheet prefix spells it. Bare is an allow-list, so that it reads back as the name: one
// word that the grammar reads as no reference in either notation and as no boolean.
export function quoteSheetName(name: string): string {
    const bare = isWord(name) && !readsAsReference(name) && !NEVER_BARE.test(name);
    return bare ? name : quotedSheetName(name);
}

// What two sheet names are compared by: Excel's upper case, which folds each character on its own, so the Greek
// final ς matches σ and ß never matches ss.
export function sheetNameKey(name: string): string {
    return upperCase(name);
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
