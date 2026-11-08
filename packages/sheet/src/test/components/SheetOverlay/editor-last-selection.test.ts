// With several ranges selected, Enter and typing open the last range's focus cell. The editor's box, its style and the
// formula bar read that cell too, not the first range's.

import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { InputBox } = await import('../../../components/SheetOverlay/InputBox');
const { FxEditor } = await import('../../../components/FxEditor');

type Cell = import('../../../state').Cell;

const FIRST: Cell = { v: 'first', m: 'first', bg: '#ff0000' };
const LAST: Cell = { v: 'last', m: 'last', bg: '#00ff00' };

const render = (part: typeof InputBox, editingCellPosition: number[] = []) =>
    renderSheetDialog(
        () => {},
        {
            allowEdit: true,
            editingCellPosition,
            sheets: [
                {
                    id: 'one',
                    name: 'One',
                    order: 0,
                    config: {},
                    data: [
                        [FIRST, null, null],
                        [null, null, LAST],
                    ],
                },
            ],
            currentSheetId: 'one',
            selections: [
                { row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0, left: 0, top: 0, width: 99, height: 19 },
                {
                    row: [1, 1],
                    column: [2, 2],
                    row_focus: 1,
                    column_focus: 2,
                    left: 200,
                    top: 20,
                    width: 99,
                    height: 19,
                },
            ],
        },
        () => createElement(part),
    );

test('the open editor sits on the last range, in its cell style', async () => {
    await render(InputBox, [1, 2]);
    await act(async () => {});
    const box = document.querySelector<HTMLElement>('.sheet-input-box');
    expect(box?.style.left).toBe('200px');
    expect(box?.style.top).toBe('20px');
    expect(box?.innerHTML).toContain('#00ff00');
});

test('the formula bar shows the last range focus cell', async () => {
    await render(FxEditor);
    await act(async () => {});
    expect(document.querySelector('#sheet-functionbox-cell')?.textContent).toBe('last');
});
