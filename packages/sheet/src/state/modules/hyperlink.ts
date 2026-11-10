// A cell's link: saving and removing it, the card that shows it, and following it to a web page, a sheet or a range.
// The link card and the grid's mouse handlers call it, for example to find the cell under the mouse. A link to a
// sheet names that sheet, and following it finds the sheet by name. Saving new text writes over the cell, so the
// formulas that read it recompute.

import { resolveWebLink } from '@workspace/lib/sheets/web-link';
import { cloneDeep } from 'es-toolkit/compat';
import { findSheetByName } from '../../engine/a1-notation';
import { cellValue, dropRuns } from '../../engine/format';
import { iscelldata } from '../../engine/formula-utils';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import { mergeBorder } from './cell';
import { getcellrange } from './formula-exec';
import { cellRectAt, colLocation, rowLocation, sheetPoint } from './location';
import { recomputeCells } from './refresh';
import { normalizeSelection } from './selection';
import { changeSheet } from './sheet';

// The cell under the pointer, or none in the blank margin a scroll to the end shows past the last row or column.
export function getCellRowColumn(ctx: Context, e: MouseEvent, cellArea: HTMLDivElement) {
    const flowdata = getFlowdata(ctx);
    if (flowdata == null) return undefined;
    const { x, y } = sheetPoint(ctx, e, cellArea);
    if (x > (ctx.visibledatacolumn.at(-1) ?? 0) || y > (ctx.visibledatarow.at(-1) ?? 0)) return undefined;
    let r = rowLocation(y, ctx.visibledatarow)[2];
    let c = colLocation(x, ctx.visibledatacolumn)[2];

    const merged = mergeBorder(ctx, flowdata, r, c);
    if (merged) {
        [, , r] = merged.row;
        [, , c] = merged.column;
    }

    return { r, c };
}

export function getCellHyperlink(ctx: Context, r: number, c: number) {
    return getFlowdata(ctx)?.[r]?.[c]?.link;
}

export function saveHyperlink(
    ctx: Context,
    r: number,
    c: number,
    linkText: string,
    linkType: string,
    linkAddress: string,
) {
    const flowdata = getFlowdata(ctx);
    if (flowdata != null && linkType && linkAddress) {
        const cell = (flowdata[r][c] ??= {});
        cell.link = { type: linkType, address: linkAddress };
        cell.fc = 'rgb(0, 0, 255)';
        cell.un = 1;
        // New text replaces the cell's value, its formula and a rich cell's runs, as in Excel; the text the card
        // showed, left as it was, keeps the cell as it was.
        const text = linkText || linkAddress;
        if (`${cellValue(cell) ?? ''}` !== text) {
            dropRuns(cell);
            delete cell.f;
            cell.v = text;
            cell.m = text;
            recomputeCells(ctx, [{ r, c, id: ctx.currentSheetId }]);
        }
        ctx.linkCard = undefined;
    }
}

export function removeHyperlink(ctx: Context, r: number, c: number) {
    if (ctx.allowEdit === false) return;
    const cell = getFlowdata(ctx)?.[r]?.[c];
    if (cell) {
        delete cell.link;
        delete cell.fc;
        delete cell.un;
    }
    ctx.linkCard = undefined;
}

export function showLinkCard(ctx: Context, r: number, c: number, isEditing = false, isMouseDown = false) {
    const d = getFlowdata(ctx);
    if (d == null || `${r}_${c}` === ctx.linkCard?.rc) return;
    const cell = d[r]?.[c];
    const link = cell?.link;
    if (
        !isEditing &&
        link == null &&
        (isMouseDown || !ctx.linkCard?.isEditing || ctx.linkCard.sheetId !== ctx.currentSheetId)
    ) {
        ctx.linkCard = undefined;
        return;
    }
    if (
        isEditing ||
        (link != null && (!ctx.linkCard?.isEditing || isMouseDown)) ||
        ctx.linkCard?.sheetId !== ctx.currentSheetId
    ) {
        ctx.linkCard = {
            sheetId: ctx.currentSheetId,
            r,
            c,
            rc: `${r}_${c}`,
            originText: `${cellValue(cell) ?? ''}`,
            originType: link?.type ?? 'webpage',
            originAddress: link?.address ?? '',
            position: cellRectAt(ctx, d, r, c),
            isEditing,
        };
    }
}

export function goToLink(ctx: Context, r: number, c: number) {
    const link = getCellHyperlink(ctx, r, c);
    if (link == null) return;
    if (link.type === 'webpage') {
        const address = resolveWebLink(link.address);
        if (address != null) window.open(address, '_blank', 'noopener,noreferrer');
    } else if (link.type === 'sheet') {
        const sheetId = findSheetByName(ctx.sheets, link.address)?.id;
        if (sheetId != null) changeSheet(ctx, sheetId);
    } else {
        const range = cloneDeep(getcellrange(ctx, link.address));
        if (range == null) return;
        const sheetId = range.sheetId || ctx.currentSheetId;
        changeSheet(ctx, sheetId);
        if (ctx.currentSheetId !== sheetId) return;
        const top = range.row[0] === 0 ? 0 : ctx.visibledatarow[range.row[0] - 1];
        const left = range.column[0] === 0 ? 0 : ctx.visibledatacolumn[range.column[0] - 1];
        ctx.scrollRequest = { left, top };
        ctx.selections = normalizeSelection(ctx, [range]);
    }
    ctx.linkCard = undefined;
}

// A space anywhere between the scheme and the first /, ? or #.
const HOST_WITH_SPACE = /^[^/?#]*:\/*[^/?#]*\s/;

export function isLinkValid(linkType: string, linkAddress: string) {
    if (!linkAddress) return { isValid: false, tooltip: '' };
    if (linkType === 'webpage') {
        // Valid means goToLink would open it. Chrome's parser escapes a space in the host name instead of refusing it.
        const address = resolveWebLink(linkAddress);
        if (address == null || !URL.canParse(address) || HOST_WITH_SPACE.test(address)) {
            return { isValid: false, tooltip: 'Please enter a valid link' };
        }
    }
    if (linkType === 'cellrange' && !iscelldata(linkAddress)) {
        return { isValid: false, tooltip: 'Please enter a valid cell range, such as Sheet1!A1:C8' };
    }
    return { isValid: true, tooltip: '' };
}
