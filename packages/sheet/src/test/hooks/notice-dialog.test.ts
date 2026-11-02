// A notice, such as a refused edit, or a yes or no, such as a sheet delete. It announces its message as the dialog's
// description, closes itself on OK after running onOk, and closes on Cancel or its corner X without running it.

import { expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act } = await import('react');
const { renderSheetDialog } = await import('../components/sheet-dialog');

const MESSAGE = 'There is already data here, do you want to replace it?';

test('a notice announces its message, and OK closes it', async () => {
    const dialog = await renderSheetDialog((d) => d.showDialog(MESSAGE, 'ok'));
    const [notice] = dialog.dialogs();
    expect(dialog.title()).toBe('Notice');
    const describedBy = notice?.getAttribute('aria-describedby');
    expect(describedBy && document.getElementById(describedBy)?.textContent).toBe(MESSAGE);
    expect(dialog.button('Cancel')).toBeUndefined();
    await dialog.click('OK');
    expect(dialog.dialogs()).toHaveLength(0);
});

test('a yes or no runs onOk on OK and closes', async () => {
    const onOk = mock(() => {});
    const dialog = await renderSheetDialog((d) => d.showDialog(MESSAGE, 'yesno', onOk));
    await dialog.click('OK');
    expect(onOk).toHaveBeenCalledTimes(1);
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Cancel and the corner X close a yes or no without running onOk', async () => {
    const onOk = mock(() => {});
    const dialog = await renderSheetDialog((d) => d.showDialog(MESSAGE, 'yesno', onOk));
    await dialog.click('Cancel');
    expect(dialog.dialogs()).toHaveLength(0);

    const again = await renderSheetDialog((d) => d.showDialog(MESSAGE, 'yesno', onOk));
    await act(async () => document.querySelector<HTMLElement>('[data-slot="dialog-close"]')?.click());
    expect(again.dialogs()).toHaveLength(0);
    expect(onOk).not.toHaveBeenCalled();
});
