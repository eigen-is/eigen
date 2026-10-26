// What both writers of a workbook read, the HTML renderer and the xlsx writer: the cells' resolver, the alignment
// codes and the test for a real rotation. They live apart from the HTML renderer so the xlsx writer, which loads
// alone, never pulls in the sanitizer behind it.

import type { Cell, Sheet } from '@workspace/lib/sheets';
import type { CellResolver } from '@workspace/sheet/engine';
import { createArrayResolver } from '@workspace/sheet/engine';

// The sheets' cells as the export reads them: the dense data every sheet carries once materialized.
export function sheetsResolver(sheets: Sheet[]): CellResolver {
    return createArrayResolver(
        sheets.map((sheet) => ({
            id: sheet.id ?? sheet.name,
            name: sheet.name,
            data: sheet.data ?? null,
            calculationChain: [],
            dynamicArrayCompute: [],
        })),
    );
}

export const HORIZONTAL_ALIGN: Record<number, 'left' | 'center' | 'right'> = {
    0: 'center',
    1: 'left',
    2: 'right',
};

export const VERTICAL_ALIGN: Record<number, 'top' | 'middle' | 'bottom'> = {
    0: 'middle',
    1: 'top',
    2: 'bottom',
};

// `rt` is schemaless and also carries the non-numeric 'vertical' writing mode, so a real
// rotation is only a number inside Excel's ±90 range.
export function isNumericRotation(v: Cell | null): v is Cell & { rt: number } {
    return !!v && typeof v.rt === 'number' && v.rt !== 0 && v.rt >= -90 && v.rt <= 90;
}
