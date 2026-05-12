import type { Context } from '..';
import { mergeCells as mergeCellsInternal } from '../modules';
import type { Range } from '../types';
import { type CommonOptions, getSheet } from './common';

export function mergeCells(ctx: Context, ranges: Range, type: string, options: CommonOptions = {}) {
    const sheet = getSheet(ctx, options);
    mergeCellsInternal(ctx, sheet.id!, ranges, type);
}

export function cancelMerge(ctx: Context, ranges: Range, options: CommonOptions = {}) {
    mergeCells(ctx, ranges, 'merge-cancel', options);
}
