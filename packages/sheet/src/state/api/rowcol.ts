// Sets the sizes of rows and columns on the current sheet, in pixels, such as for the resize dialog or a pasted table's
// row heights. A custom size is one a person chose, which a later auto-fit leaves alone.

import type { Context } from '../context';
import { getSheet } from './common';

export function setRowHeight(ctx: Context, rowInfo: Record<string, number>, custom = false) {
    const cfg = (getSheet(ctx).config ??= {});
    const rowlen = (cfg.rowlen ??= {});
    for (const [r, len] of Object.entries(rowInfo)) {
        // A pasted table's height attribute can be anything.
        if (!(len >= 0)) continue;
        rowlen[r] = len;
        if (custom) (cfg.customHeight ??= {})[r] = 1;
    }
}

export function setColumnWidth(ctx: Context, columnInfo: Record<string, number>, custom = false) {
    const cfg = (getSheet(ctx).config ??= {});
    const columnlen = (cfg.columnlen ??= {});
    for (const [c, len] of Object.entries(columnInfo)) {
        if (!(len >= 0)) continue;
        columnlen[c] = len;
        if (custom) (cfg.customWidth ??= {})[c] = 1;
    }
}
