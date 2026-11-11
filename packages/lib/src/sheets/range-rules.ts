// A sheet's range rules, its conditional formats and its data-validation rules: each kind a record of rules by id,
// every rule over its ranges with a fractional order key. The shape checks and caps sit here, where a rule enters a
// workbook, such as a decoded snapshot and a collaborator's write: a peer can store anything under an id, so a rule
// that is not well formed, or past a cap, is left out where it arrives. The readers and writers of rules share the
// order, the key a new rule takes and the range helpers below.

import { parseRgb } from '../constants/colors';
import { isRecord } from '../core/guards';
import { generateKeyBetween, isValidFractionalIndex } from '../vector/fractional-index';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from './defaults';
import type { ConditionalFormatRule, DataValidationRule, SheetValidation, SingleRange } from './types';

// The most ranges one rule holds, which bounds what one write of a rule costs every tab. Excel's selection holds at
// most 2,048 ranges, and the editor's cuts split a range into up to four.
export const MAX_RULE_RANGES = 4 * 2048;

// The most rules of one kind a sheet holds; the fullest sheet in our xlsx corpus has 16 validation rules. With the
// range cap it bounds what a reader that walks every rule pays, such as the painter and the export.
export const MAX_VALIDATIONS = 1024;
export const MAX_CONDITIONAL_FORMATS = 1024;

type RangeRule = { ranges: SingleRange[]; order: string };
export type RuleStore<R extends RangeRule = RangeRule> = { max: number; holds: (value: unknown) => value is R };

const VALIDATIONS: RuleStore<SheetValidation> = { max: MAX_VALIDATIONS, holds: isSheetValidation };
const CONDITIONAL_FORMATS: RuleStore<ConditionalFormatRule> = {
    max: MAX_CONDITIONAL_FORMATS,
    holds: isConditionalFormat,
};

// The cap and the shape check of the rules a sheet field holds, for a field that holds rules.
export function ruleStoreOf(field: unknown): RuleStore | undefined {
    if (field === 'dataValidations') return VALIDATIONS;
    return field === 'conditionalFormats' ? CONDITIONAL_FORMATS : undefined;
}

// Whether a value is a whole record of well-formed rules within the store's cap.
export function holdsOnlyRules<R extends RangeRule>(store: RuleStore<R>, value: unknown): value is Record<string, R> {
    if (!isRecord(value)) return false;
    const rules = Object.entries(value);
    return rules.length <= store.max && rules.every(([id, rule]) => holdsRule(store, id, rule));
}

// A sheet's rules of one kind without the ones that are not well formed, and past the cap without the last in order.
// A record whose every rule is well formed comes back as the same object, so normalizing a draft sheet writes nothing.
export function wellFormedValidations(value: unknown): Record<string, SheetValidation> {
    return wellFormedRules(VALIDATIONS, value);
}

export function wellFormedConditionalFormats(value: unknown): Record<string, ConditionalFormatRule> {
    return wellFormedRules(CONDITIONAL_FORMATS, value);
}

// A sheet's rules with their ids, first to last, and the last rule over a cell wins it. Rules two peers added at once
// share a key, and every reader then orders them by id.
export function orderedRules<R extends { order: string }>(
    rules: Readonly<Record<string, R>> | undefined,
): [string, R][] {
    return Object.entries(rules ?? {}).sort(([idA, a], [idB, b]) => compareRules(a.order, idA, b.order, idB));
}

export function compareRules(orderA: string, idA: string, orderB: string, idB: string): number {
    if (orderA !== orderB) return orderA < orderB ? -1 : 1;
    return idA < idB ? -1 : idA > idB ? 1 : 0;
}

// The order key of a rule added after every rule the sheet holds, so the newest rule is the last.
export function nextRuleOrder(rules: Readonly<Record<string, { order: string }>> | undefined): string {
    let last: string | null = null;
    for (const { order } of Object.values(rules ?? {})) if (last === null || order > last) last = order;
    return generateKeyBetween(last, null);
}

// The type each field of a rule holds. Typed against the rule, so a field added to it fails the build until it is
// checked here too.
const RULE_FIELDS: Record<keyof DataValidationRule, 'string' | 'boolean'> = {
    type: 'string',
    type2: 'string',
    value1: 'string',
    value2: 'string',
    hintShow: 'boolean',
    hintValue: 'string',
    prohibitInput: 'boolean',
};
const REQUIRED_RULE_FIELDS: ReadonlySet<string> = new Set<keyof DataValidationRule>([
    'type',
    'type2',
    'value1',
    'value2',
]);

function isSheetValidation(value: unknown): value is SheetValidation {
    if (!isRangeRule(value)) return false;
    const { rule } = value;
    if (!isRecord(rule)) return false;
    return Object.entries(RULE_FIELDS).every(
        ([field, kind]) =>
            typeof rule[field] === kind || (rule[field] === undefined && !REQUIRED_RULE_FIELDS.has(field)),
    );
}

// What the evaluator and the exports read of a rule: a rule's values are strings or numbers, its looks two optional
// colors, and a scale's stops colors the painter can parse.
function isConditionalFormat(value: unknown): value is ConditionalFormatRule {
    if (!isRangeRule(value)) return false;
    const { type, format, conditionName, conditionValue } = value;
    if (type === 'default') {
        return (
            isRecord(format) &&
            isOptionalColor(format['textColor']) &&
            isOptionalColor(format['cellColor']) &&
            typeof conditionName === 'string' &&
            Array.isArray(conditionValue) &&
            conditionValue.every((item) => typeof item === 'string' || typeof item === 'number')
        );
    }
    if (!Array.isArray(format) || !format.every((color) => typeof color === 'string')) return false;
    if (type === 'dataBar') return true;
    return type === 'colorGradation' && format.every((color) => color.startsWith('#') || parseRgb(color) !== undefined);
}

// The same cells in fewer ranges. Two ranges of one width join where they touch or overlap, first down the rows,
// then across the columns, so a duplicate goes and one cell pasted down a column becomes one range.
export function coalescedRanges(ranges: readonly SingleRange[]): SingleRange[] {
    return mergedAlong(mergedAlong(ranges, 'row'), 'column');
}

export function rangesOverlap(a: SingleRange, b: SingleRange): boolean {
    return a.row[0] <= b.row[1] && b.row[0] <= a.row[1] && a.column[0] <= b.column[1] && b.column[0] <= a.column[1];
}

// A write by id never reaches an own `__proto__` key, so a rule stored under that id could not be deleted.
function holdsRule<R extends RangeRule>(store: RuleStore<R>, id: string, rule: unknown): rule is R {
    return id !== '__proto__' && store.holds(rule);
}

function isOptionalColor(color: unknown): boolean {
    return color == null || typeof color === 'string';
}

// Every reader walks a rule's ranges and sorts by its order key, and a new rule's key is made from the last one.
function isRangeRule(value: unknown): value is Record<string, unknown> & RangeRule {
    if (!isRecord(value)) return false;
    const { ranges, order } = value;
    return (
        typeof order === 'string' &&
        isValidFractionalIndex(order, undefined, undefined) &&
        Array.isArray(ranges) &&
        ranges.length > 0 &&
        ranges.length <= MAX_RULE_RANGES &&
        ranges.every(
            (range) =>
                isRecord(range) &&
                isSpan(range['row'], REFERENCE_ROW_COUNT) &&
                isSpan(range['column'], REFERENCE_COLUMN_COUNT),
        )
    );
}

function wellFormedRules<R extends RangeRule>(store: RuleStore<R>, value: unknown): Record<string, R> {
    if (holdsOnlyRules(store, value)) return value;
    if (!isRecord(value)) return {};
    const kept: Record<string, R> = {};
    for (const [id, rule] of Object.entries(value)) if (holdsRule(store, id, rule)) kept[id] = rule;
    return Object.fromEntries(orderedRules(kept).slice(0, store.max));
}

function isSpan(span: unknown, count: number): boolean {
    return (
        Array.isArray(span) &&
        span.length === 2 &&
        span.every((end) => Number.isInteger(end) && end >= 0 && end < count) &&
        span[0] <= span[1]
    );
}

// Ranges sorted by their span across the axis, then joined along it where one span repeats and the runs touch.
function mergedAlong(ranges: readonly SingleRange[], axis: 'row' | 'column'): SingleRange[] {
    const across = axis === 'row' ? 'column' : 'row';
    const sorted = [...ranges].sort(
        (a, b) => a[across][0] - b[across][0] || a[across][1] - b[across][1] || a[axis][0] - b[axis][0],
    );
    const merged: SingleRange[] = [];
    for (const range of sorted) {
        const last = merged.at(-1);
        const sameSpan = last && last[across][0] === range[across][0] && last[across][1] === range[across][1];
        if (!sameSpan || range[axis][0] > last[axis][1] + 1) {
            merged.push(range);
            continue;
        }
        if (range[axis][1] <= last[axis][1]) continue;
        const run = [last[axis][0], range[axis][1]];
        merged[merged.length - 1] = axis === 'row' ? { row: run, column: last.column } : { row: last.row, column: run };
    }
    return merged;
}
