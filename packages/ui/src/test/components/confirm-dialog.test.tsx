// A confirm dialog closes once its action succeeds, whatever the action resolves with. One whose action fails stays open
// for another try, unless the server refused it: asking again gets the same no, so the dialog closes and leaves the
// error toast to say why.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { AppError, onMutationError } = await import('@workspace/lib/api-error');
const { ConfirmDialog } = await import('../../components/confirm-dialog');

let unmount = async () => {};
afterEach(() => unmount());

async function confirmWith(onConfirm: () => void | Promise<void>) {
    const onOpenChange = mock((_open: boolean) => {});
    ({ unmount } = await renderInDocument(
        createElement(ConfirmDialog, {
            open: true,
            onOpenChange,
            title: 'Delete team',
            description: 'Delete it?',
            confirmText: 'Delete',
            onConfirm,
        }),
    ));
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Delete');
    if (!confirm) throw new Error('no confirm button');
    await act(async () => {
        confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    return onOpenChange.mock.calls;
}

function confirmFailingWith(status: number) {
    // The mutation hook toasts its failure before the dialog sees it.
    const failure = new AppError({ error: { status, value: 'No' }, status });
    onMutationError(failure);
    return confirmWith(() => Promise.reject(failure));
}

test('an action that resolves with data closes the dialog, even when the data is false', async () => {
    // A handler typed as returning nothing may still hand back what its mutation resolved, such as a boolean.
    const deleted: () => void = () => Promise.resolve(false);
    expect(await confirmWith(deleted)).toEqual([[false]]);
    await unmount();
    const created: () => void = () => Promise.resolve({ id: 't1' });
    expect(await confirmWith(created)).toEqual([[false]]);
});

test('a refused action closes the dialog', async () => {
    expect(await confirmFailingWith(403)).toEqual([[false]]);
});

test('an action that may go through on another try keeps the dialog open', async () => {
    expect(await confirmFailingWith(500)).toEqual([]);
});

test('while its action runs the confirm button shows a spinner, ignores a click and keeps the focus', async () => {
    let finish = () => {};
    const onConfirm = mock(() => new Promise<void>((resolve) => (finish = resolve)));
    const onOpenChange = mock((_open: boolean) => {});
    ({ unmount } = await renderInDocument(
        createElement(ConfirmDialog, {
            open: true,
            onOpenChange,
            title: 'Delete team',
            description: 'Delete it?',
            confirmText: 'Delete',
            onConfirm,
        }),
    ));
    const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-footer"] button')];
    const [cancel, confirm] = buttons();
    confirm?.focus();
    await act(async () => confirm?.click());
    expect(confirm?.getAttribute('aria-busy')).toBe('true');
    expect(confirm?.disabled).toBe(false);
    expect(cancel?.disabled).toBe(true);
    expect(document.activeElement).toBe(confirm ?? null);
    await act(async () => confirm?.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});
