// A dialog opened by a value has none until its first open, keeps the value when it closes, so its text stays
// while it fades out, and takes the next open's value.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { useDialogValue } = await import('../../hooks/use-dialog-value');

let unmount = async () => {};
afterEach(() => unmount());

test('closing keeps the value, and the next open replaces it', async () => {
    let dialog: ReturnType<typeof useDialogValue<string>> | undefined;
    function Harness() {
        dialog = useDialogValue<string>();
        return null;
    }
    ({ unmount } = await renderInDocument(createElement(Harness)));
    expect([dialog?.open, dialog?.value]).toEqual([false, undefined]);

    await act(async () => dialog?.openDialog('first'));
    expect([dialog?.open, dialog?.value]).toEqual([true, 'first']);

    await act(async () => dialog?.setOpen(false));
    expect([dialog?.open, dialog?.value]).toEqual([false, 'first']);

    await act(async () => dialog?.openDialog('second'));
    expect([dialog?.open, dialog?.value]).toEqual([true, 'second']);
});
