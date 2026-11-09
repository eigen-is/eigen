// A cell's link: saving and removing it, the card that shows it, and following it to a web page, a sheet or a range.
// The link card and the grid's mouse handlers call it, for example to find the cell under the mouse. A link to a
// sheet names that sheet, and following it finds the sheet by name. Saving new text writes over the cell, so the
// formulas that read it recompute.

import { resolveWebLink } from '@workspace/lib/sheets/web-link';
import { cloneDeep, omit, set } from 'es-toolkit/compat';
import { findSheetByName } from '../../engine/a1-notation';
import { cellValue, dropRuns } from '../../engine/format';
import { iscelldata } from '../../engine/formula-utils';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import { getSheetIndex } from '../utils';
import { mergeBorder } from './cell';
import { getcellrange } from './formula-exec';
import { colLocation, rowLocation, sheetPoint } from './location';
import { recomputeCells } from './refresh';
import { normalizeSelection } from './selection';
import { changeSheet } from './sheet';

export function getCellRowColumn(ctx: Context, e: MouseEvent, cellArea: HTMLDivElement) {
    const flowdata = getFlowdata(ctx);
    if (flowdata == null) return undefined;
    const { x, y } = sheetPoint(ctx, e, cellArea);
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
    const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
    if (sheetIndex != null) {
        return ctx.sheets[sheetIndex].hyperlink?.[`${r}_${c}`];
    }
    return undefined;
}

export function saveHyperlink(
    ctx: Context,
    r: number,
    c: number,
    linkText: string,
    linkType: string,
    linkAddress: string,
) {
    const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
    const flowdata = getFlowdata(ctx);
    if (sheetIndex != null && flowdata != null && linkType && linkAddress) {
        const cell = (flowdata[r][c] ??= {});
        set(ctx.sheets[sheetIndex], ['hyperlink', `${r}_${c}`], {
            linkType,
            linkAddress,
        });
        cell.fc = 'rgb(0, 0, 255)';
        cell.un = 1;
        cell.hl = { r, c, id: ctx.currentSheetId };
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
    const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
    const flowdata = getFlowdata(ctx);
    if (flowdata != null && sheetIndex != null) {
        const hyperlink = omit(ctx.sheets[sheetIndex].hyperlink, `${r}_${c}`);
        set(ctx.sheets[sheetIndex], 'hyperlink', hyperlink);
        const cell = flowdata[r][c];
        if (cell != null) {
            const { fc: _fc, un: _un, hl: _hl, ...rest } = cell;
            flowdata[r][c] = rest;
        }
    }
    ctx.linkCard = undefined;
}

export function showLinkCard(ctx: Context, r: number, c: number, isEditing = false, isMouseDown = false) {
    if (`${r}_${c}` === ctx.linkCard?.rc) return;
    const link = getCellHyperlink(ctx, r, c);
    const cell = getFlowdata(ctx)?.[r]?.[c];
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
            originType: link?.linkType || 'webpage',
            originAddress: link?.linkAddress || '',
            position: {
                cellLeft: c === 0 ? 0 : ctx.visibledatacolumn[c - 1],
                cellBottom: ctx.visibledatarow[r],
            },
            isEditing,
        };
    }
}

export function goToLink(ctx: Context, r: number, c: number, linkType: string, linkAddress: string) {
    const currSheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
    if (currSheetIndex == null) return;
    if (ctx.sheets[currSheetIndex].hyperlink?.[`${r}_${c}`] == null) {
        return;
    }
    if (linkType === 'webpage') {
        const address = resolveWebLink(linkAddress);
        if (address != null) window.open(address, '_blank', 'noopener,noreferrer');
    } else if (linkType === 'sheet') {
        const sheetId = findSheetByName(ctx.sheets, linkAddress)?.id;
        if (sheetId != null) changeSheet(ctx, sheetId);
    } else {
        const range = cloneDeep(getcellrange(ctx, linkAddress));
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
