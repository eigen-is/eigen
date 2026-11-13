import type { Literal, SheetSource } from '../../store/workbook';

export type TestCell = readonly [row: number, column: number, value: Literal | null, formula?: string];

export function source(id: string, cells: readonly TestCell[]): SheetSource {
    return {
        id,
        name: id,
        cells: (cell) => {
            for (const [row, column, value, formula] of cells) cell(row, column, value, formula ?? null);
        },
    };
}

// A small seeded generator, so a failing run can be repeated.
export function random(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}
