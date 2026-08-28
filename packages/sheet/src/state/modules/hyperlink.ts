import { resolveWebLink } from '@workspace/lib/sheets/web-link';
import { cloneDeep, omit, set } from 'es-toolkit/compat';
import { iscelldata } from '../../engine/formula-utils';
import { type Context, getFlowdata } from '../context';
import { en } from '../locale/en';
import type { GlobalCache } from '../types';
import { getSheetIndex, isAllowEdit } from '../utils';
import { mergeBorder } from './cell';
import { getcellrange } from './formula-exec';
import { colLocation, rowLocation } from './location';
import { normalizeSelection } from './selection';
import { changeSheet } from './sheet';

export function getCellRowColumn(ctx: Context, e: MouseEvent, container: HTMLDivElement, scrollEl: HTMLDivElement) {
    const flowdata = getFlowdata(ctx);
    if (flowdata == null) return undefined;
    const { scrollLeft, scrollTop } = scrollEl;
    const rect = container.getBoundingClientRect();
    let x = e.pageX - rect.left - ctx.rowHeaderWidth;
    let y = e.pageY - rect.top - ctx.columnHeaderHeight;
    x += scrollLeft;
    y += scrollTop;
    let r = rowLocation(y, ctx.visibledatarow)[2];
    let c = colLocation(x, ctx.visibledatacolumn)[2];

    const margeset = mergeBorder(ctx, flowdata, r, c);
    if (margeset) {
        [, , r] = margeset.row;
        [, , c] = margeset.column;
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
        let cell = flowdata[r][c];
        if (cell == null) cell = {};
        set(ctx.sheets[sheetIndex], ['hyperlink', `${r}_${c}`], {
            linkType,
            linkAddress,
        });
        cell.fc = 'rgb(0, 0, 255)';
        cell.un = 1;
        cell.v = linkText || linkAddress;
        cell.m = linkText || linkAddress;
        cell.hl = { r, c, id: ctx.currentSheetId };
        flowdata[r][c] = cell;
        ctx.linkCard = undefined;
    }
}

export function removeHyperlink(ctx: Context, r: number, c: number) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;
    const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
    const flowdata = getFlowdata(ctx);
    if (flowdata != null && sheetIndex != null) {
        const hyperlink = omit(ctx.sheets[sheetIndex].hyperlink, `${r}_${c}`);
        set(ctx.sheets[sheetIndex], 'hyperlink', hyperlink);
        const cell = flowdata[r][c];
        if (cell != null) {
            flowdata[r][c] = { v: cell.v, m: cell.m };
        }
    }
    ctx.linkCard = undefined;
}

export function showLinkCard(ctx: Context, r: number, c: number, isEditing = false, isMouseDown = false) {
    if (ctx.linkCard?.selectingCellRange) return;
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
        const col_pre = c - 1 === -1 ? 0 : ctx.visibledatacolumn[c - 1];
        const row = ctx.visibledatarow[r];
        ctx.linkCard = {
            sheetId: ctx.currentSheetId,
            r,
            c,
            rc: `${r}_${c}`,
            originText: cell?.v == null ? '' : `${cell.v}`,
            originType: link?.linkType || 'webpage',
            originAddress: link?.linkAddress || '',
            position: {
                cellLeft: col_pre,
                cellBottom: row,
            },
            isEditing,
        };
    }
}

export function goToLink(
    ctx: Context,
    r: number,
    c: number,
    linkType: string,
    linkAddress: string,
    scrollEl: HTMLDivElement,
) {
    const currSheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
    if (currSheetIndex == null) return;
    if (ctx.sheets[currSheetIndex].hyperlink?.[`${r}_${c}`] == null) {
        return;
    }
    if (linkType === 'webpage') {
        const address = resolveWebLink(linkAddress);
        if (address != null) window.open(address, '_blank', 'noopener,noreferrer');
    } else if (linkType === 'sheet') {
        const sheetId = ctx.sheets.find((sheet) => sheet.name === linkAddress)?.id;
        if (sheetId != null) changeSheet(ctx, sheetId);
    } else {
        const range = cloneDeep(getcellrange(ctx, linkAddress));
        if (range == null) return;
        const row_pre = range.row[0] - 1 === -1 ? 0 : ctx.visibledatarow[range.row[0] - 1];
        const col_pre = range.column[0] - 1 === -1 ? 0 : ctx.visibledatacolumn[range.column[0] - 1];
        scrollEl.scrollLeft = col_pre;
        scrollEl.scrollTop = row_pre;
        ctx.selections = normalizeSelection(ctx, [range]);
        changeSheet(ctx, range.sheetId || ctx.currentSheetId);
    }
    ctx.linkCard = undefined;
}

export function isLinkValid(linkType: string, linkAddress: string) {
    if (!linkAddress) return { isValid: false, tooltip: '' };
    const { insertLink } = en;
    if (linkType === 'webpage') {
        // Valid means "navigation would open it": the same resolveWebLink gate
        // goToLink uses, plus a structural parse — one fact, one place.
        const address = resolveWebLink(linkAddress);
        if (address == null || !URL.canParse(address)) {
            return { isValid: false, tooltip: insertLink.tooltipInfo1 };
        }
    }
    if (linkType === 'cellrange' && !iscelldata(linkAddress)) {
        return { isValid: false, tooltip: insertLink.invalidCellRangeTip };
    }
    return { isValid: true, tooltip: '' };
}

export function onRangeSelectionModalMoveStart(_ctx: Context, globalCache: GlobalCache, e: MouseEvent) {
    const box = document.querySelector('div.sheet-link-modify-modal.range-selection-modal') as HTMLDivElement;
    if (!box) return;
    const { width, height } = box.getBoundingClientRect();
    const left = box.offsetLeft;
    const top = box.offsetTop;
    const initialPosition = { left, top, width, height };
    set(globalCache, 'linkCard.rangeSelectionModal', {
        cursorMoveStartPosition: {
            x: e.pageX,
            y: e.pageY,
        },
        initialPosition,
    });
}

export function onRangeSelectionModalMove(globalCache: GlobalCache, e: MouseEvent) {
    const moveProps = globalCache.linkCard?.rangeSelectionModal;
    if (moveProps == null) return;
    const modal = document.querySelector('div.sheet-link-modify-modal.range-selection-modal');
    const { x: startX, y: startY } = moveProps.cursorMoveStartPosition!;
    let { top, left } = moveProps.initialPosition!;
    left += e.pageX - startX;
    top += e.pageY - startY;
    if (top < 0) top = 0;
    (modal as HTMLDivElement).style.left = `${left}px`;
    (modal as HTMLDivElement).style.top = `${top}px`;
}

export function onRangeSelectionModalMoveEnd(globalCache: GlobalCache) {
    set(globalCache, 'linkCard.rangeSelectionModal', undefined);
}
