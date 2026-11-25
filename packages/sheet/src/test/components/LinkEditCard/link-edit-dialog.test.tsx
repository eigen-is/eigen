// The Insert link dialog keeps the dialog contract: Apply stays live, and a cell range Sheets can't read, or none at
// all, says why under its field and takes the focus. The shared address field's own tests cover a web address, and the
// link card's tests how the dialog opens and comes back from the range picker.

import { expect, test } from 'bun:test';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { createElement } = await import('react');
const { renderSheetDialog, sheetDialogForm, typeInto } = await import('../sheet-dialog');
const { LinkEditDialog } = await import('../../../components/LinkEditCard/LinkEditDialog');
type CellLinkType = import('@workspace/lib/sheets').CellLinkType;

const SHEETS = [{ id: 'id_1', name: 'Sheet1', order: 0, config: {}, data: [[null, null]] }];

// A new link of this type on A1.
const openLink =
    (originType: CellLinkType = 'webpage') =>
    (d: Parameters<Parameters<typeof sheetDialogForm>[0]>[0]) =>
        d.showDialog(
            createElement(LinkEditDialog, {
                link: {
                    sheetId: 'id_1',
                    r: 0,
                    c: 0,
                    rc: '0_0',
                    originText: '',
                    originType,
                    originAddress: '',
                    position: { left: 0, top: 0, right: 74, bottom: 20 },
                    isEditing: true,
                },
            }),
        );

const problem = () => document.querySelector('[role="dialog"] [data-slot="field-error"]')?.textContent;

test('Insert link keeps the dialog contract', async () => {
    const form = sheetDialogForm(openLink('cellrange'), { sheets: SHEETS });
    await expectFormContract({
        kind: 'dialog',
        render: form.render,
        submitLabel: 'Apply',
        firstField: 'Display text',
        onSubmit: form.write,
        makeChanged: () => typeInto('Cell range', 'Sheet1!B2'),
        makeInvalid: () => typeInto('Cell range', 'A1:'),
        invalidField: 'Cell range',
        savesAtOnce: true,
    });
});

test('Apply keeps the dialog while the web address is empty', async () => {
    const dialog = await renderSheetDialog(openLink(), { sheets: SHEETS });
    await dialog.click('Apply');
    expect(dialog.context().sheets[0].data?.[0]?.[0]).toBeNull();
    expect(dialog.dialogs()).toHaveLength(1);
});

test('an empty cell range says so once Apply is pressed', async () => {
    const dialog = await renderSheetDialog(openLink('cellrange'), { sheets: SHEETS });
    await dialog.click('Apply');
    expect(problem()).toBe('Enter a cell range, such as A1:B10');
    expect(document.activeElement).toBe(dialog.field('Cell range'));
    await dialog.type('Cell range', 'A1:');
    expect(problem()).toBe('Please enter a valid cell range, such as Sheet1!A1:C8');
});
