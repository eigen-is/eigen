// A sheet's data-validation rules as it stores them: each rule once, with the ranges it covers, under an id. This
// module finds the rule over a cell, for the hit tests and the input check, and once per paint for the painter. It
// also takes cells out of the rules and puts a rule on cells, for writers such as the validation dialog, a paste and
// a fill. A cell has at most one rule, so putting a rule on cells first takes them out of every other rule.

import { cfSplitRange } from '../../engine/conditional-format';
import type { DataVerificationRule, Sheet, SheetValidation, SingleRange } from '../types';

// The rule over one cell, with its id. Two peers putting rules on one cell at once can leave the cell in two rules,
// and an xlsx file can hold overlapping ones. The highest id then wins on every tab: a longer id is higher, and ids of
// one length compare by their characters. So of the rules an import numbers in the file's order, the last one wins.
export function validationEntryAt(
    validations: Sheet['dataValidations'],
    r: number,
    c: number,
): [string, SheetValidation] | undefined {
    let found: [string, SheetValidation] | undefined;
    for (const [id, entry] of Object.entries(validations ?? {})) {
        if ((!found || byId(id, found[0]) > 0) && entry.ranges.some((range) => covers(range, r, c))) {
            found = [id, entry];
        }
    }
    return found;
}

export function validationAt(validations: Sheet['dataValidations'], r: number, c: number) {
    return validationEntryAt(validations, r, c)?.[1].rule;
}

// The painter's lookup for one paint. The rules are cut down once to the ranges inside the window it paints, so a
// cell checks only those, however many rules the sheet has elsewhere. A cell outside the window, which the text
// overflow can ask about, is looked up in full.
export function validationLookup(
    validations: Sheet['dataValidations'],
    window: SingleRange,
): (r: number, c: number) => DataVerificationRule | undefined {
    const inView: [string, SheetValidation][] = [];
    for (const [id, { ranges, rule }] of Object.entries(validations ?? {})) {
        const near = ranges.filter((range) => overlaps(range, window));
        if (near.length > 0) inView.push([id, { ranges: near, rule }]);
    }
    inView.sort(([a], [b]) => byId(b, a));
    return (r, c) =>
        covers(window, r, c)
            ? inView.find(([, { ranges }]) => ranges.some((range) => covers(range, r, c)))?.[1].rule
            : validationAt(validations, r, c);
}

// Takes an area out of every rule on the sheet, and drops a rule left with no cell. A changed rule is written whole
// under its id: a write into its ranges alone would fail where a peer deleted the rule meanwhile, and take the rest
// of its batch with it.
export function clearValidations(sheet: Sheet, area: SingleRange) {
    const validations = (sheet.dataValidations ??= {});
    for (const [id, entry] of Object.entries(validations)) {
        if (!entry.ranges.some((range) => overlaps(range, area))) continue;
        const ranges = entry.ranges.flatMap((range) => cfSplitRange(range, area, area, 'restPart'));
        if (ranges.length > 0) validations[id] = { ...entry, ranges };
        else delete validations[id];
    }
}

// Puts a rule on ranges of the sheet under an id. The ranges join the ones the id already has, and its rule stays.
export function addValidation(sheet: Sheet, id: string, rule: DataVerificationRule, ranges: SingleRange[]) {
    for (const range of ranges) clearValidations(sheet, range);
    const validations = (sheet.dataValidations ??= {});
    const entry = validations[id];
    validations[id] = { ranges: [...(entry?.ranges ?? []), ...ranges], rule: entry?.rule ?? rule };
}

function byId(a: string, b: string) {
    return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function covers(range: SingleRange, r: number, c: number) {
    return r >= range.row[0] && r <= range.row[1] && c >= range.column[0] && c <= range.column[1];
}

function overlaps(a: SingleRange, b: SingleRange) {
    return a.row[0] <= b.row[1] && b.row[0] <= a.row[1] && a.column[0] <= b.column[1] && b.column[0] <= a.column[1];
}
