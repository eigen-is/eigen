// Sets the current sheet's selection, as the grid does when it first shows a sheet without one. The sheet keeps its
// own copy, which a switch back to it restores.

import type { Context } from '../context';
import { normalizeSelection } from '../modules';
import type { Range } from '../types';
import { getSheet } from './common';

export function setSelection(ctx: Context, range: Range) {
    const sheet = getSheet(ctx);
    sheet.selections = normalizeSelection(ctx, range);
    ctx.selections = sheet.selections;
}
