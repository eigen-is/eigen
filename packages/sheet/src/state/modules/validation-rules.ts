// A sheet's data-validation rules as it stores them: each rule once, with the ranges it covers, under an id. This
// module finds the rule over a cell, for the hit tests and the input check, and once per paint for the painter. It
// also takes cells out of the rules and puts a rule on cells, for writers such as the validation dialog, a paste and
// a fill. A cell has at most one rule, so putting a rule on cells first takes them out of every other rule.

import {
    coalescedRanges,
    compareValidationIds,
    MAX_VALIDATION_RANGES,
    MAX_VALIDATIONS,
    rangesOverlap,
} from '@workspace/lib/sheets';
import { cfSplitRange } from '../../engine/conditional-format';
import type { DataValidationRule, Sheet, SheetValidation, SingleRange } from '../types';

// The rule over one cell, with its id. Two peers putting rules on one cell at once can leave the cell in two rules,
// and an xlsx file can hold overlapping ones. The highest id then wins on every tab (compareValidationIds).
export function validationEntryAt(
    validations: Readonly<Sheet['dataValidations']>,
    r: number,
    c: number,
): [string, SheetValidation] | undefined {
    let found: [string, SheetValidation] | undefined;
    for (const [id, entry] of Object.entries(validations ?? {})) {
        if ((!found || compareValidationIds(id, found[0]) > 0) && entry.ranges.some((range) => covers(range, r, c))) {
            found = [id, entry];
        }
    }
    return found;
}

export function validationAt(validations: Readonly<Sheet['dataValidations']>, r: number, c: number) {
    return validationEntryAt(validations, r, c)?.[1].rule;
}

// The painter's lookup for one paint. The rules over the window it paints are laid out once into a grid of its cells,
// lowest id first, so the highest id wins a cell two rules cover, and a cell costs one read however many rules the
// sheet has. A cell outside the window, which the text overflow can ask about, is looked up in full once.
export function validationLookup(
    validations: Readonly<Sheet['dataValidations']>,
    window: SingleRange,
): (r: number, c: number) => DataValidationRule | undefined {
    const [top, bottom] = window.row;
    const [left, right] = window.column;
    const width = right - left + 1;
    const inView: (DataValidationRule | undefined)[] = [];
    const entries = Object.entries(validations ?? {}).sort(([a], [b]) => compareValidationIds(a, b));
    for (const [, { ranges, rule }] of entries) {
        for (const { row, column } of ranges) {
            for (let r = Math.max(row[0], top); r <= Math.min(row[1], bottom); r += 1) {
                const from = (r - top) * width - left;
                for (let c = Math.max(column[0], left); c <= Math.min(column[1], right); c += 1) {
                    inView[from + c] = rule;
                }
            }
        }
    }
    const outside = new Map<string, DataValidationRule | undefined>();
    return (r, c) => {
        if (covers(window, r, c)) return inView[(r - top) * width + c - left];
        const key = `${r}_${c}`;
        if (!outside.has(key)) outside.set(key, validationAt(validations, r, c));
        return outside.get(key);
    };
}

// A writer throws this where an edit would leave a rule with more ranges than a rule may hold, or a sheet with more
// rules than a sheet may hold. Every peer, the server and a reload would drop such a rule, so the Workbook refuses
// the whole edit instead, and shows the message.
export class ValidationLimitError extends Error {
    public constructor() {
        super('This edit would make a data validation rule too complex.');
        this.name = 'ValidationLimitError';
    }
}

// Takes an area out of every rule on the sheet, and drops a rule left with no cell. A changed rule is written whole
// under its id: a write into its ranges alone would fail where a peer deleted the rule meanwhile, and take the rest
// of its batch with it.
export function clearValidations(sheet: Sheet, area: SingleRange) {
    const validations = (sheet.dataValidations ??= {});
    for (const [id, entry] of Object.entries(validations)) {
        if (!entry.ranges.some((range) => rangesOverlap(range, area))) continue;
        const ranges = entry.ranges.flatMap((range) => cfSplitRange(range, area, area, 'restPart'));
        if (ranges.length > MAX_VALIDATION_RANGES) throw new ValidationLimitError();
        if (ranges.length > 0) validations[id] = { ...entry, ranges };
        else delete validations[id];
    }
}

// Puts a rule on ranges of the sheet under an id. The ranges join the ones the id already has, and its rule stays.
// They are coalesced on the way in, so a paste or a fill that lands one range per cell leaves the rule a few ranges.
export function addValidation(sheet: Sheet, id: string, rule: DataValidationRule, ranges: readonly SingleRange[]) {
    const landed = coalescedRanges(ranges);
    for (const range of landed) clearValidations(sheet, range);
    const validations = (sheet.dataValidations ??= {});
    const entry = validations[id];
    const joined = coalescedRanges([...(entry?.ranges ?? []), ...landed]);
    if (joined.length > MAX_VALIDATION_RANGES) throw new ValidationLimitError();
    if (!entry && Object.keys(validations).length >= MAX_VALIDATIONS) throw new ValidationLimitError();
    validations[id] = { ranges: joined, rule: entry?.rule ?? rule };
}

function covers(range: SingleRange, r: number, c: number) {
    return r >= range.row[0] && r <= range.row[1] && c >= range.column[0] && c <= range.column[1];
}
