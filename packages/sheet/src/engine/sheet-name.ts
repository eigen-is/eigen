// A sheet's name: the one it takes when the workbook already holds its own, such as a copy the tab menu's Duplicate
// makes or a tab Import… brings, the one it takes in a file that breaks the rule, and a rename, which every text naming
// the sheet follows. It is DOM-free, so the editor names copies as the API does, and a live tab renames as the op
// replay does.

import type { Sheet } from '@workspace/lib/sheets';
import { stripNonXmlChars } from '@workspace/lib/xml';
import {
    MAX_SHEET_NAME_LENGTH,
    SHEET_NAME_END_QUOTES,
    SHEET_NAME_FORBIDDEN,
    sheetFinder,
    sheetNameKey,
} from './a1-notation';
import { renameSheetRefs, rewriteSheetFormulas } from './formula-shift';
import { iscelldata } from './formula-utils';

export type RenameSheetOp = { id: string; name: string };

// Whether a sheet other than `id` holds the name. A name is taken in any case, as Excel compares names.
export function sheetNameTaken(sheets: readonly Sheet[], id: string, name: string): boolean {
    const key = sheetNameKey(name);
    return sheets.some((sheet) => sheet.id !== id && sheetNameKey(sheet.name) === key);
}

// The sheets with one renamed and every text naming it pointed at the new name.
export function applySheetRename<S extends Sheet>(sheets: S[], { id, name }: RenameSheetOp): S[] {
    const target = sheets.find((sheet) => sheet.id === id);
    if (!target) return sheets;
    // Of two renames to one name, the later in the log fails on every reader. Both would repoint formulas at one sheet.
    if (sheetNameTaken(sheets, id, name)) throw new Error('Another sheet already has this name');
    const findSheet = sheetFinder(sheets);
    const renames = new Map([[target.name, name]]);
    return sheets.map((sheet) => renameSheetTexts(sheet.id === id ? { ...sheet, name } : sheet, findSheet, renames));
}

// The sheet with every text that names a renamed sheet pointed at its new name: formulas, formula rules, list sources
// and links. A chart ref names its sheet by id and needs nothing. Text that stays keeps its object.
export function renameSheetTexts<S extends Sheet>(
    sheet: S,
    findSheet: (name: string) => { name: string } | undefined,
    renames: ReadonlyMap<string, string>,
): S {
    const rename = (txt: string) => renameSheetRefs(txt, findSheet, renames);
    let next = rewriteSheetFormulas(sheet, rename);
    let dataValidations: Sheet['dataValidations'] | null = null;
    for (const [key, entry] of Object.entries(sheet.dataValidations ?? {})) {
        const { rule } = entry;
        if (rule.type !== 'dropdown' || !iscelldata(rule.value1)) continue;
        const value1 = rename(rule.value1);
        if (value1 === rule.value1) continue;
        dataValidations ??= { ...sheet.dataValidations };
        dataValidations[key] = { ...entry, rule: { ...rule, value1 } };
    }
    if (dataValidations) next = { ...next, dataValidations };
    let hyperlink: Sheet['hyperlink'] | null = null;
    for (const [key, link] of Object.entries(sheet.hyperlink ?? {})) {
        let { linkAddress } = link;
        if (link.linkType === 'cellrange') linkAddress = rename(linkAddress);
        else if (link.linkType === 'sheet') {
            const target = findSheet(linkAddress);
            linkAddress = (target && renames.get(target.name)) ?? linkAddress;
        }
        if (linkAddress === link.linkAddress) continue;
        hyperlink ??= { ...sheet.hyperlink };
        hyperlink[key] = { ...link, linkAddress };
    }
    return hyperlink ? { ...next, hyperlink } : next;
}

// "Sheet1(Copy)", then "Sheet1(Copy2)", past the highest copy number taken, within the 31 characters a sheet name may
// have. A name is taken in any case, as Excel compares names.
export function copySheetName(name: string, taken: readonly string[]): string {
    const copyWord = '(Copy';
    const copyAt = name.indexOf(copyWord);
    const base = copyAt === -1 ? name : name.substring(0, copyAt);
    const nameCopy = sheetNameKey(base + copyWord);
    const takenKeys = taken.map(sheetNameKey);
    let index = 0;
    for (const other of takenKeys) {
        if (!other.startsWith(nameCopy)) continue;
        index = index || 2;
        const num = Number.parseInt(other.substring(nameCopy.length, other.indexOf(')', nameCopy.length)), 10);
        if (Number.isFinite(num) && num >= index) index = num + 1;
    }

    let copy: string;
    do {
        const postfix = `${copyWord + (index || '')})`;
        const lengthLimit = MAX_SHEET_NAME_LENGTH - postfix.length;
        copy = base.length > lengthLimit ? `${fit(base, lengthLimit - 1)}…` : base;
        copy += postfix;
        index = (index || 1) + 1;
    } while (takenKeys.includes(sheetNameKey(copy)));
    return copy;
}

// What a file's sheets are called, each name following the sheet-name rule and unique in any case. The first holding a
// name keeps it, and any other is repaired, then numbered as Excel numbers a copy, past every name the workbook holds.
// `reserved` lists names a writer may not use at all.
export function legalSheetNames(names: readonly string[], reserved: readonly string[] = []): string[] {
    const taken = new Set(reserved.map(sheetNameKey));
    const kept = names.map((name) => {
        if (!name || name !== legalSheetName(name) || taken.has(sheetNameKey(name))) return undefined;
        taken.add(sheetNameKey(name));
        return name;
    });
    return kept.map((name, index) => {
        if (name !== undefined) return name;
        const base = legalSheetName(names[index]) || `Sheet${index + 1}`;
        let candidate = base;
        for (let copy = 2; taken.has(sheetNameKey(candidate)); copy += 1) {
            const suffix = ` (${copy})`;
            candidate = `${fit(base, MAX_SHEET_NAME_LENGTH - suffix.length)}${suffix}`;
        }
        taken.add(sheetNameKey(candidate));
        return candidate;
    });
}

function legalSheetName(name: string): string {
    const replaced = stripNonXmlChars(name).replace(SHEET_NAME_FORBIDDEN, '_');
    return fit(replaced, MAX_SHEET_NAME_LENGTH).replace(SHEET_NAME_END_QUOTES, '');
}

// A cut between a surrogate pair's halves leaves a character XML can't hold, which the strip takes off.
function fit(name: string, length: number): string {
    return name.length > length ? stripNonXmlChars(name.slice(0, length)) : name;
}
