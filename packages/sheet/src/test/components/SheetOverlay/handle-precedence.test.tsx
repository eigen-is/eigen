// A mounted Workbook's selection handles against what the cell under them paints. A press on the move band at a corner
// mark starts a move, as anywhere on the band, since a mark claims nothing. A press on a handle over a list chevron or
// a tick box is left to the cell, which opens the list or ticks the box.
import { afterEach, expect, test } from 'bun:test';
import { SHEET_DEFAULT_COL_WIDTH } from '@workspace/lib/sheets';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { validationsByCell } from '../../state/factories/validations';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
type Sheet = import('../../../state').Sheet;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

// Where column c starts in the cell area.
const left = (c: number) => c * SHEET_DEFAULT_COL_WIDTH;

// Row 1: A a comment, B a number that fails its rule, C a list, D a tick box.
async function mount() {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const workbook = createRef<WorkbookInstance>();
    const data: Sheet[] = [
        {
            id: 's1',
            name: 'One',
            order: 0,
            row: 10,
            column: 5,
            celldata: [
                { r: 0, c: 0, v: { v: 'a', m: 'a', commentCardIds: ['c1'] } },
                { r: 0, c: 1, v: { v: 1, m: '1' } },
                { r: 0, c: 3, v: { v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } } },
            ],
            config: {},
            dataValidations: validationsByCell({
                '0_1': { type: 'number', type2: 'moreThanThe', value1: '3', value2: '' },
                '0_2': { type: 'dropdown', type2: '', value1: 'Red,Green', value2: '' },
                '0_3': { type: 'checkbox', type2: '', value1: 'TRUE', value2: 'FALSE' },
            }),
        },
    ];
    const commentCards = { c1: { id: 'c1', title: 'One', description: '' } };
    await act(async () => {
        root.render(createElement(Workbook, { ref: workbook, data, commentCards }));
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    const find = (selector: string) => {
        const element = container.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`no ${selector}`);
        return element;
    };
    // happy-dom lays nothing out, and a press outside the area's rect is no press on a cell.
    find('.sheet-cell-area').getBoundingClientRect = () => new DOMRect(0, 0, 600, 400);
    // Selects the cell with a click near its left edge, clear of what it paints, then presses one of its handles.
    const pressHandle = async (c: number, handle: string, clientX: number, clientY: number) => {
        for (const type of ['mousedown', 'mouseup']) {
            await act(async () => {
                const click = new MouseEvent(type, { bubbles: true, clientX: left(c) + 20, clientY: 10 });
                find('.sheet-cell-table').dispatchEvent(click);
            });
        }
        await act(async () => {
            find(handle).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX, clientY }));
        });
    };
    const moving = () => find('.sheet-cell-selected-move').style.display === 'block';
    return { find, pressHandle, moving, workbook };
}

test('a press on the move band at a comment mark starts a move', async () => {
    const { pressHandle, moving } = await mount();
    await pressHandle(0, '.sheet-cs-draghandle-top', left(1) - 3, 1);
    expect(moving()).toBe(true);
});

test('a press on the move band at an invalid mark starts a move', async () => {
    const { pressHandle, moving } = await mount();
    await pressHandle(1, '.sheet-cs-draghandle-left', left(1) + 1, 5);
    expect(moving()).toBe(true);
});

test('a press on the fill handle over a list chevron starts no fill drag and no move', async () => {
    const { pressHandle, moving, find } = await mount();
    await pressHandle(2, '.sheet-cs-fillhandle', left(3) - 6, 13);
    expect(moving()).toBe(false);
    expect(find('.sheet-cell-area').style.cursor).not.toBe('crosshair');
});

test('a press on the move band over a tick box ticks it, and starts no move', async () => {
    const { pressHandle, moving, workbook } = await mount();
    await pressHandle(3, '.sheet-cs-draghandle-top', (left(3) + left(4)) / 2 - 1, 10);
    expect(moving()).toBe(false);
    expect(workbook.current?.getFlowdata()?.[0]?.[3]?.v).toBe(true);
});
