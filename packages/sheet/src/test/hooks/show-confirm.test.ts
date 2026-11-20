// A yes or no in the sheet's slot, such as a sheet delete, is the shared ConfirmDialog. It runs onConfirm on its verb
// and closes, and closes on Cancel or its corner X without running it.

import { expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act } = await import('react');
const { renderSheetDialog } = await import('../components/sheet-dialog');

const confirm = (onConfirm: () => void) =>
    renderSheetDialog((d) =>
        d.showConfirm({
            title: 'Delete sheet?',
            description: 'Delete Sheet2?',
            confirmText: 'Delete',
            destructive: true,
            onConfirm,
        }),
    );

test('it reads its title and sentence, and its verb runs onConfirm and closes', async () => {
    const onConfirm = mock(() => {});
    const dialog = await confirm(onConfirm);
    const [question] = dialog.dialogs();
    expect(dialog.title()).toBe('Delete sheet?');
    const describedBy = question?.getAttribute('aria-describedby');
    expect(describedBy && document.getElementById(describedBy)?.textContent).toBe('Delete Sheet2?');
    expect(dialog.footer()).toEqual(['Cancel', 'Delete']);
    expect(dialog.button('Delete')?.dataset.variant).toBe('destructive');
    await dialog.click('Delete');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Cancel and the corner X close it without running onConfirm', async () => {
    const onConfirm = mock(() => {});
    const dialog = await confirm(onConfirm);
    await dialog.click('Cancel');
    expect(dialog.dialogs()).toHaveLength(0);

    const again = await confirm(onConfirm);
    await act(async () => document.querySelector<HTMLElement>('[data-slot="dialog-close"]')?.click());
    expect(again.dialogs()).toHaveLength(0);
    expect(onConfirm).not.toHaveBeenCalled();
});
