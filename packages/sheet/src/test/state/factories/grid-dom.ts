// Minimal DOM for the drag handlers, which measure from the cell area. It sits below and right of the headers, as in
// the grid, so a test's page point counts the headers in, and its numbers live here rather than in every test.

import { SHEET_COLUMN_HEADER_HEIGHT, SHEET_ROW_HEADER_WIDTH } from '@workspace/lib/sheets';
import { Window } from 'happy-dom';
import type { Context } from '../../../state/context';
import { handleOverlayMouseUp } from '../../../state/events/mouse-drag';
import { onDropCellSelectEnd } from '../../../state/modules/drop-cell';
import type { GlobalCache, SingleRange } from '../../../state/types';

const win = new Window();
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.window = win;
g.document = win.document;
g.HTMLElement = win.HTMLElement;
g.NodeFilter = win.NodeFilter;
g.Text = win.Text;

export const GRID_GEOMETRY = {
    defaultrowlen: 19,
    defaultcollen: 73,
} as const;

export function withGridGeometry(ctx: Context): Context {
    Object.assign(ctx, GRID_GEOMETRY);
    return ctx;
}

// The grid's container and scroll element, from this module's DOM. The globals are re-asserted per
// call: the module-scope assignment doesn't re-run for cached imports, and a sibling test file in
// the same process may have deleted the window or put a stub document in its place.
export function gridElements(): { container: HTMLDivElement; scrollEl: HTMLDivElement } {
    g.window = win;
    g.document = win.document;
    g.HTMLElement = win.HTMLElement;
    g.NodeFilter = win.NodeFilter;
    g.Text = win.Text;
    const container = win.document.createElement('div') as unknown as HTMLDivElement;
    container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
    const scrollEl = win.document.createElement('div') as unknown as HTMLDivElement;
    scrollEl.getBoundingClientRect = () =>
        ({
            left: SHEET_ROW_HEADER_WIDTH,
            top: SHEET_COLUMN_HEADER_HEIGHT,
            width: 800 - SHEET_ROW_HEADER_WIDTH,
            height: 600 - SHEET_COLUMN_HEADER_HEIGHT,
        }) as DOMRect;
    return { container, scrollEl };
}

export function mouseUpAt(clientX: number, clientY: number) {
    return (ctx: Context) => {
        const { container, scrollEl } = gridElements();
        const event = { button: 0, clientX, clientY } as unknown as MouseEvent;
        handleOverlayMouseUp(ctx, {} as GlobalCache, event, scrollEl, container, null, null);
    };
}

// Drags the fill handle from the corner of `copyRange` to the far end of `applyRange`, as a person does, on a grid of
// 20 by 100 px cells. The apply range lies on one side of the copy range and spans its rows or columns.
export function dragFill(
    ctx: Context,
    copyRange: SingleRange,
    applyRange: SingleRange,
    direction: 'up' | 'down' | 'left' | 'right',
) {
    const rows = Math.max(applyRange.row[1], copyRange.row[1]) + 1;
    const columns = Math.max(applyRange.column[1], copyRange.column[1]) + 1;
    ctx.visibledatarow = Array.from({ length: rows }, (_, i) => (i + 1) * 20);
    ctx.visibledatacolumn = Array.from({ length: columns }, (_, i) => (i + 1) * 100);
    const [top, bottom] = copyRange.row;
    const [left, right] = copyRange.column;
    ctx.cellSelectExtendIndex = [bottom, right];
    ctx.selections = [
        {
            row: copyRange.row,
            column: copyRange.column,
            row_focus: top,
            column_focus: left,
            top_move: top * 20,
            left_move: left * 100,
            height_move: (bottom - top + 1) * 20 - 1,
            width_move: (right - left + 1) * 100 - 1,
        },
    ];
    const row = direction === 'up' ? applyRange.row[0] : direction === 'down' ? applyRange.row[1] : bottom;
    const column = direction === 'left' ? applyRange.column[0] : direction === 'right' ? applyRange.column[1] : right;
    const { container, scrollEl } = gridElements();
    const event = {
        clientX: SHEET_ROW_HEADER_WIDTH + column * 100 + 50,
        clientY: SHEET_COLUMN_HEADER_HEIGHT + row * 20 + 10,
    } as unknown as MouseEvent;
    onDropCellSelectEnd(ctx, event, scrollEl, container);
}
