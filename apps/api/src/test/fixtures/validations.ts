import type { ConditionalFormatRule, DataValidationRule, SheetValidation } from '@workspace/lib/sheets';
import { orderedRules, parseCellKey } from '@workspace/lib/sheets';
import { generateNKeysBetween } from '@workspace/lib/vector';

type Unordered<R> = R extends unknown ? Omit<R, 'order'> : never;

// A sheet's conditional formats from a list, first to last: the ids f1, f2 and on, each with the next order key.
export function formatsOf(rules: readonly Unordered<ConditionalFormatRule>[]): Record<string, ConditionalFormatRule> {
    const orders = generateNKeysBetween(null, null, rules.length);
    return Object.fromEntries(rules.map((rule, i) => [`f${i + 1}`, { ...rule, order: orders[i] }]));
}

// A sheet's conditional formats as the list formatsOf takes, first to last.
export function formatList(
    formats: Record<string, ConditionalFormatRule> | undefined,
): Unordered<ConditionalFormatRule>[] {
    return orderedRules(formats).map(([, { order: _, ...rule }]) => rule);
}

// A sheet's validation rules given per cell: each cell its own rule, under the cell's key as its id.
export function validationsByCell(rules: Record<string, DataValidationRule>): Record<string, SheetValidation> {
    return Object.fromEntries(
        Object.entries(rules).map(([key, rule]) => {
            const [r, c] = parseCellKey(key);
            return [key, { ranges: [{ row: [r, r], column: [c, c] }], order: 'a0', rule }];
        }),
    );
}

// The rule over one cell, the last in order winning where rules overlap, as the editor reads it.
export function ruleAt(
    validations: Record<string, SheetValidation> | undefined,
    r: number,
    c: number,
): DataValidationRule | undefined {
    const covers = ({ row, column }: { row: number[]; column: number[] }) =>
        r >= row[0] && r <= row[1] && c >= column[0] && c <= column[1];
    return orderedRules(validations).findLast(([, { ranges }]) => ranges.some(covers))?.[1].rule;
}

// The rule over each cell a sheet's rules cover, keyed "r_c" in row order. Only for small ranges.
export function rulesByCell(
    validations: Record<string, SheetValidation> | undefined,
): Record<string, DataValidationRule> {
    const cells: [number, number, DataValidationRule][] = [];
    for (const [, { ranges, rule }] of orderedRules(validations)) {
        for (const { row, column } of ranges) {
            for (let r = row[0]; r <= row[1]; r += 1) {
                for (let c = column[0]; c <= column[1]; c += 1) cells.push([r, c, rule]);
            }
        }
    }
    cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return Object.fromEntries(cells.map(([r, c, rule]) => [`${r}_${c}`, rule]));
}
