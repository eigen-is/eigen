// A sheet's name: the one it takes when the workbook already holds its own, such as a copy the tab menu's Duplicate
// makes or a tab Import… brings, the one it takes in a file that breaks the rule, a rename, which every text naming
// the sheet follows, and a delete, which breaks every text naming it. It is DOM-free, so the editor names copies as
// the API does, and a live tab renames and deletes as the op replay does.

import type { Sheet } from '@workspace/lib/sheets';
import { stripNonXmlChars } from '@workspace/lib/xml';
import {
    isSheetName,
    MAX_SHEET_NAME_LENGTH,
    SHEET_NAME_END_QUOTES,
    SHEET_NAME_FORBIDDEN,
    SHEET_NAME_RULE,
    sheetFinder,
    sheetNameKey,
} from './a1-notation';
import { breakSheetRefs, mapSheetCells, renameSheetRefs, rewriteSheetFormulas } from './formula-shift';
import { iscelldata } from './formula-utils';
import { error } from './validation';

export type RenameSheetOp = { id: string; name: string };

// Why sheet `id` can't take a name, if it can't. A name is taken in any case, as Excel compares names.
export function sheetNameRefusal(sheets: readonly Sheet[], id: string, name: string): string | undefined {
    if (name.length === 0) return 'Sheet name cannot be empty';
    if (!isSheetName(name)) return SHEET_NAME_RULE;
    const key = sheetNameKey(name);
    const taken = sheets.some((sheet) => sheet.id !== id && sheetNameKey(sheet.name) === key);
    return taken ? 'Another sheet already has this name' : undefined;
}

// The sheets with one renamed and every text naming it pointed at the new name.
export function applySheetRename<S extends Sheet>(sheets: S[], { id, name }: RenameSheetOp): S[] {
    const target = sheets.find((sheet) => sheet.id === id);
    if (!target) return sheets;
    // Of two renames to one name, the later in the log fails on every reader. Both would repoint formulas at one sheet.
    const refusal = sheetNameRefusal(sheets, id, name);
    if (refusal) throw new Error(refusal);
    const findSheet = sheetFinder(sheets);
    const renames = new Map([[target.name, name]]);
    return sheets.map((sheet) => renameSheetTexts(sheet.id === id ? { ...sheet, name } : sheet, findSheet, renames));
}

// The sheets without one, and every text naming it reading #REF!, as a row delete leaves a formula. A new sheet with
// the name doesn't heal them.
export function applySheetDelete<S extends Sheet>(sheets: S[], id: string): S[] {
    const target = sheets.find((sheet) => sheet.id === id);
    if (!target) return sheets;
    const findSheet = sheetFinder(sheets);
    return sheets
        .filter((sheet) => sheet.id !== id)
        .map((sheet) =>
            rewriteSheetTexts(
                sheet,
                (txt) => breakSheetRefs(txt, findSheet, target.name),
                (name) => (findSheet(name)?.name === target.name ? error.r : name),
            ),
        );
}

// The sheet with every text that names a renamed sheet pointed at its new name.
export function renameSheetTexts<S extends Sheet>(
    sheet: S,
    findSheet: (name: string) => { name: string } | undefined,
    renames: ReadonlyMap<string, string>,
): S {
    return rewriteSheetTexts(
        sheet,
        (txt) => renameSheetRefs(txt, findSheet, renames),
        (name) => {
            const target = findSheet(name);
            return (target && renames.get(target.name)) ?? name;
        },
    );
}

// The sheet with `rewrite` run over every text holding references, such as its formulas, formula rules, list sources
// and links, and `rewriteName` over a link's bare sheet name. A chart ref names its sheet by id and needs nothing. Text
// that stays keeps its object.
function rewriteSheetTexts<S extends Sheet>(
    sheet: S,
    rewrite: (txt: string) => string,
    rewriteName: (name: string) => string,
): S {
    let next = rewriteSheetFormulas(sheet, rewrite);
    let dataValidations: Sheet['dataValidations'] | null = null;
    for (const [key, entry] of Object.entries(sheet.dataValidations ?? {})) {
        const { rule } = entry;
        if (rule.type !== 'dropdown' || !iscelldata(rule.value1)) continue;
        const value1 = rewrite(rule.value1);
        if (value1 === rule.value1) continue;
        dataValidations ??= { ...sheet.dataValidations };
        dataValidations[key] = { ...entry, rule: { ...rule, value1 } };
    }
    if (dataValidations) next = { ...next, dataValidations };
    return mapSheetCells(next, (cell) => {
        const { link } = cell;
        if (!link) return cell;
        let { address } = link;
        if (link.type === 'cellrange') address = rewrite(address);
        else if (link.type === 'sheet') address = rewriteName(address);
        return address === link.address ? cell : { ...cell, link: { ...link, address } };
    });
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

// What a file's sheets are called, each unique in any case. The first holding a name keeps it, and any other is
// repaired, then numbered as Excel numbers a copy. `reserved` lists names a writer may not use at all.
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
