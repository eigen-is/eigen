// A sheet's name: the one it takes when the workbook already holds its own, such as a copy the tab menu's Duplicate
// makes or a tab Import… brings, and a rename, which every text naming the sheet follows. It is DOM-free, so the editor
// names copies as the API does, and a live tab renames as the op replay does.

import type { Sheet } from '@workspace/lib/sheets';
import { MAX_SHEET_NAME_LENGTH, sheetFinder, sheetNameKey } from './a1-notation';
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
        copy = base.length > lengthLimit ? `${base.slice(0, lengthLimit - 1)}…` : base;
        copy += postfix;
        index = (index || 1) + 1;
    } while (takenKeys.includes(sheetNameKey(copy)));
    return copy;
}
