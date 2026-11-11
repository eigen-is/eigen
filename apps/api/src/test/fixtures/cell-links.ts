// The links of a sheet's cells, keyed by 'row_column', for a test to compare against.

import type { CellLink, Sheet } from '@workspace/lib/sheets';

export function cellLinks(sheet: Pick<Sheet, 'celldata'>): Record<string, CellLink> {
    const links: Record<string, CellLink> = {};
    for (const { r, c, v } of sheet.celldata ?? []) {
        if (v?.link) links[`${r}_${c}`] = v.link;
    }
    return links;
}
