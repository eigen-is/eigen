// The Insert link dialog keeps the dialog contract: Apply stays live, and an address Sheets can't open, or none at all,
// says why under its field and takes the focus. The link card's own tests cover how the dialog opens and comes back
// from the range picker.

import { expect, test } from 'bun:test';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { createElement } = await import('react');
const { renderSheetDialog, sheetDialogForm, SYNCHRONOUS_WRITE, typeInto } = await import('../sheet-dialog');
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
    const form = sheetDialogForm(openLink(), { sheets: SHEETS });
    await expectFormContract({
        kind: 'dialog',
        render: form.render,
        submitLabel: 'Apply',
        firstField: 'Display text',
        onSubmit: form.write,
        makeChanged: () => typeInto('Link address', 'https://eigen.is'),
        makeInvalid: () => typeInto('Link address', 'javascript:alert(1)'),
        invalidField: 'Link address',
        except: SYNCHRONOUS_WRITE,
    });
});

test('an empty address says so once Apply is pressed', async () => {
    const dialog = await renderSheetDialog(openLink(), { sheets: SHEETS });
    expect(problem()).toBeUndefined();
    await dialog.click('Apply');
    expect(problem()).toBe('Enter a link address');
    expect(document.activeElement).toBe(dialog.field('Link address'));
    expect(dialog.dialogs()).toHaveLength(1);
});

test('an empty cell range says so once Apply is pressed', async () => {
    const dialog = await renderSheetDialog(openLink('cellrange'), { sheets: SHEETS });
    await dialog.click('Apply');
    expect(problem()).toBe('Enter a cell range');
    expect(document.activeElement).toBe(dialog.field('Cell range'));
    await dialog.type('Cell range', 'A1:');
    expect(problem()).toBe('Please enter a valid cell range, such as Sheet1!A1:C8');
});
