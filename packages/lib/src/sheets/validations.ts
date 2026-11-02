// The shape check a sheet's data-validation entries pass where they enter a workbook: a decoded snapshot and a
// collaborator's write. A peer can store anything under an id, and every reader, such as the painter, the row and
// column shift and the export, walks an entry's ranges and reads its rule. So an entry that is not well formed is left
// out where it arrives, and those readers can trust the type.

import { isRecord } from '../core/guards';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from './defaults';
import type { DataVerificationRule, SheetValidation } from './types';

// The type each field of a rule holds. Typed against the rule, so a field added to it fails the build until it is
// checked here too.
const RULE_FIELDS: Record<keyof DataVerificationRule, 'string' | 'boolean'> = {
    type: 'string',
    type2: 'string',
    value1: 'string',
    value2: 'string',
    hintShow: 'boolean',
    hintValue: 'string',
    prohibitInput: 'boolean',
    rangeTxt: 'string',
    validity: 'string',
    remote: 'boolean',
};
const REQUIRED_RULE_FIELDS: ReadonlySet<string> = new Set<keyof DataVerificationRule>([
    'type',
    'type2',
    'value1',
    'value2',
]);

export function isSheetValidation(value: unknown): value is SheetValidation {
    if (!isRecord(value)) return false;
    const { ranges, rule } = value;
    if (!Array.isArray(ranges) || ranges.length === 0 || !isRecord(rule)) return false;
    return (
        ranges.every(
            (range) =>
                isRecord(range) &&
                isSpan(range['row'], REFERENCE_ROW_COUNT) &&
                isSpan(range['column'], REFERENCE_COLUMN_COUNT),
        ) &&
        Object.entries(RULE_FIELDS).every(
            ([field, kind]) =>
                typeof rule[field] === kind || (rule[field] === undefined && !REQUIRED_RULE_FIELDS.has(field)),
        )
    );
}

export function isSheetValidations(value: unknown): value is Record<string, SheetValidation> {
    return isRecord(value) && Object.values(value).every(isSheetValidation);
}

// A sheet's entries without the ones that are not well formed. A map whose every entry is well formed comes back as
// the same object, so normalizing a draft sheet writes nothing.
export function wellFormedValidations(value: unknown): Record<string, SheetValidation> {
    if (isSheetValidations(value)) return value;
    if (!isRecord(value)) return {};
    return Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, SheetValidation] => isSheetValidation(entry[1])),
    );
}

function isSpan(span: unknown, count: number): boolean {
    return (
        Array.isArray(span) &&
        span.length === 2 &&
        span.every((end) => Number.isInteger(end) && end >= 0 && end < count) &&
        span[0] <= span[1]
    );
}
