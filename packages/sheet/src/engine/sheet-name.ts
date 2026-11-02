// The name a sheet takes when the workbook already holds its own, such as a copy the tab menu's Duplicate makes or a
// tab Import… brings. It is DOM-free, so the editor and the API name copies alike.

import { MAX_SHEET_NAME_LENGTH, sheetNameKey } from './a1-notation';

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
