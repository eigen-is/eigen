// The comment under the pointer and where its cell is on the screen, for a scrolled sheet, its frozen panes and a merged
// cell. The grid sits at (300, 200) on the page, and in the frozen cases column A and rows 1 and 2 stay put. Which
// elements count as the cell, on the DOM the grid really draws, is in the SheetOverlay test.

import { describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { workbookContextFactory } = await import('../factories/context');
const { commentHoverAt } = await import('../../../state/modules/comment-hover');
type Context = import('../../../state').Context;
type Sheet = import('../../../state').Sheet;

const LEFT = 300;
const TOP = 200;
const COLUMN = 74;
const ROW = 20;
const FROZEN = { type: 'rangeBoth', range: { row_focus: 1, column_focus: 0 } } as const;

function grid(cardsAt: [number, number][] = [], frozen?: Sheet['frozen']): Context {
    const size = 40;
    const ctx = workbookContextFactory({
        visibledatarow: Array.from({ length: size }, (_, i) => (i + 1) * ROW),
        visibledatacolumn: Array.from({ length: size }, (_, i) => (i + 1) * COLUMN),
        editingCellPosition: [],
        commentCards: { c1: { id: 'c1', title: 'One', description: '' } },
    });
    const data: NonNullable<Sheet['data']> = Array.from({ length: size }, () =>
        Array.from({ length: size }, () => null),
    );
    for (const [r, c] of cardsAt) data[r][c] = { commentCardIds: ['c1'] };
    ctx.sheets[0].data = data;
    ctx.sheets[0].frozen = frozen;
    return ctx;
}

// Rows 3 to 5 of columns B and C, with the card on the merge's first cell as the grid stores it.
function mergedGrid(firstRow = 2): Context {
    const ctx = grid();
    const data = ctx.sheets[0].data;
    if (!data) throw new Error('no data');
    for (let r = firstRow; r < firstRow + 3; r++) {
        for (let c = 1; c < 3; c++) data[r][c] = { mc: { r: firstRow, c: 1 } };
    }
    data[firstRow][1] = { mc: { r: firstRow, c: 1, rs: 3, cs: 2 }, commentCardIds: ['c1'] };
    return ctx;
}

function cellArea(scrollLeft = 0, scrollTop = 0) {
    const area = document.createElement('div');
    area.getBoundingClientRect = () => new DOMRect(LEFT, TOP, 700, 500);
    area.scrollLeft = scrollLeft;
    area.scrollTop = scrollTop;
    const table = document.createElement('div');
    table.className = 'sheet-cell-table';
    area.append(table);
    return area;
}

// The hover the event reports, the pointer at (viewX, viewY) in the cell area and on its table, as a plain rect.
function hoverAt(ctx: Context, viewX: number, viewY: number, area = cellArea()) {
    const event = new MouseEvent('mousemove', { clientX: LEFT + viewX, clientY: TOP + viewY, bubbles: true });
    area.firstElementChild?.dispatchEvent(event);
    const hover = commentHoverAt(ctx, event, area);
    if (!hover) return null;
    const { x, y, width, height } = hover.rect;
    return { cardId: hover.cardId, x, y, width, height };
}

const cellRect = (x: number, y: number, width = COLUMN, height = ROW) => ({ cardId: 'c1', x, y, width, height });

describe('the rect', () => {
    test('of a cell is its box on the screen, measured from the grid', () => {
        const hover = hoverAt(grid([[2, 3]]), 3 * COLUMN + 5, 2 * ROW + 5);
        expect(hover).toEqual(cellRect(LEFT + 3 * COLUMN, TOP + 2 * ROW));
    });

    test('of the first row and column starts at the grid', () => {
        expect(hoverAt(grid([[0, 0]]), 5, 5)).toEqual(cellRect(LEFT, TOP));
    });

    test('follows the scroll', () => {
        const hover = hoverAt(grid([[22, 2]]), 30, 50, cellArea(148, 400));
        expect(hover).toEqual(cellRect(LEFT, TOP + 40));
    });

    test('in a frozen column stays at the column and follows the scroll down', () => {
        const hover = hoverAt(grid([[22, 0]], FROZEN), 30, 50, cellArea(148, 400));
        expect(hover).toEqual(cellRect(LEFT, TOP + 40));
    });

    test('in a frozen row stays at the row and follows the scroll across', () => {
        const hover = hoverAt(grid([[1, 3]], FROZEN), 100, 30, cellArea(148, 400));
        expect(hover).toEqual(cellRect(LEFT + 74, TOP + ROW));
    });

    test('in the corner of the panes ignores the scroll', () => {
        const hover = hoverAt(grid([[1, 0]], FROZEN), 30, 30, cellArea(148, 400));
        expect(hover).toEqual(cellRect(LEFT, TOP + ROW));
    });

    test('reads the frozen cell, not the one scrolled under it', () => {
        expect(hoverAt(grid([[1, 3]], FROZEN), 30, 50, cellArea(148, 400))).toBeNull();
    });

    test('of a merged cell spans the merge, wherever the pointer is on it', () => {
        const whole = cellRect(LEFT + COLUMN, TOP + 2 * ROW, 2 * COLUMN, 3 * ROW);
        expect(hoverAt(mergedGrid(), COLUMN + 5, 2 * ROW + 5)).toEqual(whole);
        expect(hoverAt(mergedGrid(), 2 * COLUMN + 5, 4 * ROW + 5)).toEqual(whole);
    });

    test('of a merged cell on the first row starts at the grid', () => {
        const hover = hoverAt(mergedGrid(0), COLUMN + 5, ROW + 5);
        expect(hover).toEqual(cellRect(LEFT + COLUMN, TOP, 2 * COLUMN, 3 * ROW));
    });

    test('of a merged cell follows the scroll', () => {
        const hover = hoverAt(mergedGrid(), 5, 10, cellArea(COLUMN, 4 * ROW));
        expect(hover).toEqual(cellRect(LEFT, TOP - 2 * ROW, 2 * COLUMN, 3 * ROW));
    });
});

describe('no comment', () => {
    test('on a plain cell', () => {
        expect(hoverAt(grid([[0, 0]]), COLUMN + 5, 5)).toBeNull();
    });

    test('on a cell whose card is gone', () => {
        const ctx = grid([[0, 0]]);
        ctx.commentCards = {};
        expect(hoverAt(ctx, 5, 5)).toBeNull();
    });

    test('before the workbook has its cards', () => {
        const ctx = grid([[0, 0]]);
        ctx.commentCards = undefined;
        expect(hoverAt(ctx, 5, 5)).toBeNull();
    });

    test('while a drag selects', () => {
        const ctx = grid([[0, 0]]);
        ctx.selectionActive = true;
        expect(hoverAt(ctx, 5, 5)).toBeNull();
    });

    test('while a press drags, such as a column resize or a fill', () => {
        const ctx = grid([[0, 0]]);
        ctx.scrolling = true;
        expect(hoverAt(ctx, 5, 5)).toBeNull();
    });

    test('past the last column or below the last row, where the grid draws no cell', () => {
        const ctx = grid([[39, 39]]);
        expect(hoverAt(ctx, 700 - 5, 500 - 105, cellArea(40 * COLUMN - 700, 40 * ROW - 400))).not.toBeNull();
        expect(hoverAt(ctx, 700 - 5, 500 - 95, cellArea(40 * COLUMN - 700, 40 * ROW - 400))).toBeNull();
        expect(hoverAt(ctx, 700 - 95, 500 - 105, cellArea(40 * COLUMN - 600, 40 * ROW - 400))).toBeNull();
    });

    test('on a cell whose link card is open, which the comment card would cover', () => {
        const ctx = grid([[0, 0]]);
        ctx.linkCard = {
            sheetId: ctx.currentSheetId,
            r: 0,
            c: 0,
            rc: '0_0',
            originText: 'Site',
            originType: 'webpage',
            originAddress: 'https://example.com',
            position: { cellLeft: 0, cellTop: 0, cellBottom: ROW },
            isEditing: false,
        };
        expect(hoverAt(ctx, 5, 5)).toBeNull();
        ctx.linkCard = { ...ctx.linkCard, r: 1, rc: '1_0' };
        expect(hoverAt(ctx, 5, 5)).not.toBeNull();
    });

    test('while a cell is being edited', () => {
        const ctx = grid([[0, 0]]);
        ctx.editingCellPosition = [5, 5];
        expect(hoverAt(ctx, 5, 5)).toBeNull();
    });
});
