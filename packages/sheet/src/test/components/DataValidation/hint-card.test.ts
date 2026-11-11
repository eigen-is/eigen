// The validation card beside the focus cell is a popover on an anchor that spans the cell, so at the grid's edge it
// flips above the cell or shifts left to stay inside the cell area rather than hang past it, as the link card does.

import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { createElement } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { ValidationHintCard } = await import('../../../components/DataValidation/HintCard');
const { validationsByCell } = await import('../../state/factories/validations');

const rule = { type: 'number', type2: 'between', value1: '1', value2: '10' };

// Radix hides a card whose anchor the cell area clips, and an anchor with no width at the area's left edge counts as
// clipped, so the card of a cell in column A never showed.
test('the card is a popover outside the grid, anchored on its whole cell', async () => {
    await renderSheetDialog(
        () => {},
        {
            sheets: [
                {
                    id: 'id_1',
                    name: 'Sheet1',
                    order: 0,
                    config: {},
                    data: [
                        [null, null],
                        [null, { v: 42, m: '42' }],
                    ],
                    dataValidations: validationsByCell({ '1_1': rule }),
                },
            ],
            selections: [{ row: [1, 1], column: [1, 1], row_focus: 1, column_focus: 1 }],
        },
        () => createElement('div', { id: 'grid' }, createElement(ValidationHintCard)),
    );
    const card = document.querySelector('[role="status"]');
    expect(card?.textContent).toBe('Invalid: Input must be a number between 1 and 10.');
    expect(card?.closest('#grid')).toBeNull();
    const anchor = document.querySelector('#grid .absolute');
    if (!(anchor instanceof HTMLElement)) throw new Error('no anchor');
    expect([anchor.style.left, anchor.style.top, anchor.style.width, anchor.style.height]).toEqual([
        '74px',
        '20px',
        '74px',
        '20px',
    ]);
});
