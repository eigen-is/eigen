// Every link of a sheet by its cell, as `r_c`, from the matrix or the stored list a joiner holds.

import type { CellLink } from '@workspace/lib/sheets';
import type { Sheet } from '../../../state/types';

export function cellLinks(sheet: Pick<Sheet, 'data' | 'celldata'>): Record<string, CellLink | undefined> {
    const links: Record<string, CellLink | undefined> = {};
    for (const [r, row] of (sheet.data ?? []).entries()) {
        for (const [c, cell] of row.entries()) if (cell?.link) links[`${r}_${c}`] = cell.link;
    }
    if (sheet.data) return links;
    for (const { r, c, v } of sheet.celldata ?? []) if (v?.link) links[`${r}_${c}`] = v.link;
    return links;
}
