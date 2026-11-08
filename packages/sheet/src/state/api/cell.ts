// Writes one attribute of a cell, on any sheet, as a host app does through the Workbook's ref to keep a comment card
// on its cells. The value lands as given: this is no typed edit, so nothing recomputes.

import type { Cell } from '../../engine/types';
import type { Context } from '../context';
import type { SheetLookup } from './common';
import { getSheet } from './common';

export function setCellFormat<K extends keyof Cell>(
    ctx: Context,
    row: number,
    column: number,
    attr: K,
    value: Cell[K],
    options: SheetLookup = {},
) {
    const { data } = getSheet(ctx, options);
    if (!data) throw new Error('sheet has no cell matrix');
    const cell: Cell = data[row][column] ?? {};
    cell[attr] = value;
    data[row][column] = cell;
}
