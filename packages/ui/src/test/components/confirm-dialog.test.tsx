// A confirm dialog whose action fails stays open for another try, unless the server refused it: asking again gets the
// same no, so the dialog closes and leaves the error toast to say why.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { AppError } = await import('@workspace/lib/api-error');
const { ConfirmDialog } = await import('../../components/confirm-dialog');

let unmount = async () => {};
afterEach(() => unmount());

async function confirmFailingWith(status: number) {
    const onOpenChange = mock((_open: boolean) => {});
    const onConfirm = () => Promise.reject(new AppError({ error: { status, value: 'No' }, status }));
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

test('a refused action closes the dialog', async () => {
    expect(await confirmFailingWith(403)).toEqual([[false]]);
});

test('an action that may go through on another try keeps the dialog open', async () => {
    expect(await confirmFailingWith(500)).toEqual([]);
});
