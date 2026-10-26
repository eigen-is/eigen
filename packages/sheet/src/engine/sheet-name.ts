import { MAX_SHEET_NAME_LENGTH } from './a1-notation';

// The name a sheet takes when the workbook already holds its own: "Sheet1(Copy)", then "Sheet1(Copy2)", past the
// highest copy number taken, within the 31 characters a sheet name may have. The tab menu's Duplicate names its copy so,
// and Import… a tab whose name is taken.
export function copySheetName(name: string, taken: readonly string[]): string {
    const copyWord = '(Copy';
    const copyAt = name.indexOf(copyWord);
    const base = copyAt === -1 ? name : name.substring(0, copyAt);
    const nameCopy = base + copyWord;
    let index = 0;
    for (const other of taken) {
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
    } while (taken.includes(copy));
    return copy;
}
