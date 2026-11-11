// A sheet's data-validation rules as it stores them: each rule once, with the ranges it covers and its order key,
// under an id. This module finds the rule over a cell, for the hit tests and the input check, and once per paint for
// the painter. It also takes cells out of the rules and puts a rule on cells, for writers such as the validation
// dialog, a paste and a fill. Putting a rule on cells first takes them out of every other rule; where rules still
// overlap, as after two peers' edits at once, the last in order has the cell. Every peer, the server and a reload drop
// a rule past the caps, so a writer makes none: a rule forgets cells, and the edit stands.

import {
    coalescedRanges,
    compareRules,
    MAX_RULE_RANGES,
    MAX_VALIDATIONS,
    nextRuleOrder,
    orderedRules,
    rangesOverlap,
} from '@workspace/lib/sheets';
import { rangeWithout } from '../../engine/conditional-format';
import type { DataValidationRule, Sheet, SheetValidation, SingleRange } from '../types';

export function validationAt(
    validations: Readonly<Sheet['dataValidations']>,
    r: number,
    c: number,
): DataValidationRule | undefined {
    let last: [string, SheetValidation] | undefined;
    for (const [id, entry] of Object.entries(validations ?? {})) {
        if (last && compareRules(entry.order, id, last[1].order, last[0]) < 0) continue;
        if (entry.ranges.some((range) => covers(range, r, c))) last = [id, entry];
    }
    return last?.[1].rule;
}

// The painter's lookup for one paint. The rules over the window it paints are laid out once into a grid of its cells,
// first to last, so the last rule wins a cell two rules cover, and a cell costs one read however many rules the sheet
// has. A cell outside the window, which the text overflow can ask about, is looked up in full once.
export function validationLookup(
    validations: Readonly<Sheet['dataValidations']>,
    window: SingleRange,
): (r: number, c: number) => DataValidationRule | undefined {
    const [top, bottom] = window.row;
    const [left, right] = window.column;
    const width = right - left + 1;
    const inView: (DataValidationRule | undefined)[] = [];
    for (const [, { ranges, rule }] of orderedRules(validations)) {
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

// Takes an area out of every rule on the sheet, and drops a rule left with no cell or split past the range cap. A
// changed rule is written whole under its id: a write into its ranges alone fails if a peer deleted the rule.
export function clearValidations(sheet: Sheet, area: SingleRange) {
    const validations = (sheet.dataValidations ??= {});
    for (const [id, entry] of Object.entries(validations)) {
        if (!entry.ranges.some((range) => rangesOverlap(range, area))) continue;
        const ranges = entry.ranges.flatMap((range) => rangeWithout(range, area));
        if (ranges.length > 0 && ranges.length <= MAX_RULE_RANGES) validations[id] = { ...entry, ranges };
        else delete validations[id];
    }
}

// Puts a rule on ranges of the sheet under an id; they join the id's ranges and are coalesced, so a paste or fill
// that lands one range per cell leaves a few. A new id's rule goes last. Past a cap the cells keep no rule, and the
// id's rule stays as it was.
export function addValidation(sheet: Sheet, id: string, rule: DataValidationRule, ranges: readonly SingleRange[]) {
    const landed = coalescedRanges(ranges);
    for (const range of landed) clearValidations(sheet, range);
    const validations = (sheet.dataValidations ??= {});
    const entry = validations[id];
    const joined = coalescedRanges([...(entry?.ranges ?? []), ...landed]);
    if (joined.length > MAX_RULE_RANGES) return;
    if (entry) validations[id] = { ...entry, ranges: joined };
    else if (Object.keys(validations).length < MAX_VALIDATIONS) {
        validations[id] = { ranges: joined, order: nextRuleOrder(validations), rule };
    }
}

function covers(range: SingleRange, r: number, c: number) {
    return r >= range.row[0] && r <= range.row[1] && c >= range.column[0] && c <= range.column[1];
}
