import type { DataVerificationRule, SheetValidation } from '@workspace/lib/sheets';
import { parseCellKey } from '@workspace/lib/sheets';

// A sheet's validation rules given per cell: each cell its own rule, under the cell's key as its id.
export function validationsByCell(rules: Record<string, DataVerificationRule>): Record<string, SheetValidation> {
    return Object.fromEntries(
        Object.entries(rules).map(([key, rule]) => {
            const [r, c] = parseCellKey(key);
            return [key, { ranges: [{ row: [r, r], column: [c, c] }], rule }];
        }),
    );
}

// The rule over each cell a sheet's rules cover, keyed "r_c" in row order. Only for small ranges.
export function rulesByCell(
    validations: Record<string, SheetValidation> | undefined,
): Record<string, DataVerificationRule> {
    const cells: [number, number, DataVerificationRule][] = [];
    for (const { ranges, rule } of Object.values(validations ?? {})) {
        for (const { row, column } of ranges) {
            for (let r = row[0]; r <= row[1]; r += 1) {
                for (let c = column[0]; c <= column[1]; c += 1) cells.push([r, c, rule]);
            }
        }
    }
    cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return Object.fromEntries(cells.map(([r, c, rule]) => [`${r}_${c}`, rule]));
}
