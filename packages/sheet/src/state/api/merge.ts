// The merge calls of the Workbook's imperative API: merging the cells of a range and undoing a merge. Each finds its
// sheet with getSheet, by id or index, and merges through the same state module the toolbar uses.

import type { Context } from '..';
import { mergeCells as mergeCellsInternal } from '../modules';
import type { Range } from '../types';
import type { CommonOptions } from './common';
import { getSheet } from './common';

export function mergeCells(ctx: Context, ranges: Range, type: string, options: CommonOptions = {}) {
    const sheet = getSheet(ctx, options);
    mergeCellsInternal(ctx, sheet.id, ranges, type);
}

export function cancelMerge(ctx: Context, ranges: Range, options: CommonOptions = {}) {
    mergeCells(ctx, ranges, 'merge-cancel', options);
}
