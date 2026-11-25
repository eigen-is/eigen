// The range picker keeps the dialog contract where a picker can: it opens on its field, and Enter or Cmd+Enter selects
// the range. It has no X, and Esc and Cancel open its opener again rather than close, so the opener's tests cover
// those. Select waits until there is a range, and a typed range Sheets can't read says why under the field.

import { expect, mock, test } from 'bun:test';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog, sheetDialogForm, SYNCHRONOUS_WRITE, typeInto } = await import('../sheet-dialog');
const { CellRangeDialog } = await import('../../../components/CellRangeDialog');
type Dialogs = Parameters<Parameters<typeof sheetDialogForm>[0]>[0];

const RANGE = 'Cell range';

// The opener the picker hands the slot back to, as the link dialog does with the pick.
let slot: Dialogs | undefined;
const reopen = () => slot?.showDialog(createElement('p', null, 'The opener'));
const select = mock((_range: string) => reopen());
const cancel = mock(reopen);

const openPicker = (d: Dialogs) => {
    slot = d;
    d.showNonModalDialog(
        createElement(CellRangeDialog, { value: '', variant: 'link', onConfirm: select, onCancel: cancel }),
        { onEscape: cancel },
    );
};

test('the range picker keeps the dialog contract', async () => {
    const form = sheetDialogForm(openPicker);
    await expectFormContract({
        kind: 'dialog',
        render: form.render,
        submitLabel: 'Select',
        firstField: RANGE,
        onSubmit: select,
        makeChanged: () => typeInto(RANGE, 'Sheet1!A1:B2'),
        makeInvalid: () => typeInto(RANGE, 'A1:'),
        invalidField: RANGE,
        except: {
            ...SYNCHRONOUS_WRITE,
            enter: 'Select hands the slot to the opener at once, so a second Enter finds no picker; tested below',
            close: 'the picker has no X, and Esc and Cancel open its opener again',
            discard: 'a pick is not typed input, and Esc and Cancel open its opener again',
        },
    });
});

test('Select waits until there is a range, and Enter hands the opener what was typed', async () => {
    select.mockClear();
    const dialog = await renderSheetDialog(openPicker);
    expect(dialog.footer()).toEqual(['Cancel', 'Select']);
    expect(dialog.button('Select')?.disabled).toBe(true);
    await dialog.type(RANGE, 'Sheet1!B2');
    await act(async () => pressEnter(dialog.field(RANGE)));
    expect(select.mock.calls).toEqual([['Sheet1!B2']]);
    expect(document.body.textContent).toContain('The opener');
});
