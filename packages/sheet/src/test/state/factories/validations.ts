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

// The cells a sheet's rules cover, as "r_c" keys in row order. Only for small ranges.
export function cellsWithRules(validations: Record<string, SheetValidation> | undefined): string[] {
    const cells: [number, number][] = [];
    for (const { ranges } of Object.values(validations ?? {})) {
        for (const { row, column } of ranges) {
            for (let r = row[0]; r <= row[1]; r += 1)
                for (let c = column[0]; c <= column[1]; c += 1) cells.push([r, c]);
        }
    }
    return cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([r, c]) => `${r}_${c}`);
}
