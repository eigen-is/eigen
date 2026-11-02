// Reset password suggests a random password on every opening, which the admin may edit, and sets it for the user
// once it is long enough. The dialog says the user is signed out everywhere, closes once the reset succeeds, and stays
// open when the server refuses it.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { MIN_PASSWORD_LENGTH } from '@workspace/lib/validation';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

type ResetInput = { userId: string; password: string };
const mutateAsync = mock(async (_input: ResetInput) => {});
const resetPassword = { mutateAsync, isPending: false };
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAdmin = { ...(await import('@workspace/lib/admin')) };
mock.module('@workspace/lib/admin', () => ({ ...realAdmin, useResetUserPassword: () => resetPassword }));
afterAll(() => {
    mock.module('@workspace/lib/admin', () => realAdmin);
});

const { act, createElement, useState } = await import('react');
const { ResetPasswordDialog } = await import('../../../components/admin/reset-password-dialog');

const onOpenChange = mock((_open: boolean) => {});
let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockImplementation(async () => {});
    onOpenChange.mockClear();
});

// The dialog under a parent that owns `open`, as the user page does, so a test can close and reopen it.
let setOpen = (_open: boolean) => {};
function Harness() {
    const [open, setOpenState] = useState(true);
    setOpen = setOpenState;
    return createElement(ResetPasswordDialog, {
        open,
        onOpenChange: (next: boolean) => {
            onOpenChange(next);
            setOpenState(next);
        },
        userId: 'u1',
        userName: 'Ada',
    });
}

async function open() {
    ({ unmount } = await renderInDocument(createElement(Harness)));
}

const field = () => {
    const input = document.getElementById('new-password');
    if (!(input instanceof HTMLInputElement)) throw new Error('the dialog has no password field');
    return input;
};
const resetButton = () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (b) => b.textContent === 'Reset password',
    );
const type = (value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field(), value);
        field().dispatchEvent(new Event('input', { bubbles: true }));
    });
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

test('it names the user, says they are signed out, and suggests a password of twelve characters', async () => {
    await open();
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Reset password for Ada');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        'They are signed out everywhere. Share the new password with them securely.',
    );
    expect(field().value).toMatch(/^[a-zA-Z2-9]{12}$/);
});

test('Reset password sets the edited password for the user, and the dialog closes', async () => {
    await open();
    await type('correct horse');
    await act(async () => resetButton()?.click());
    await settle();
    expect(mutateAsync.mock.calls).toEqual([[{ userId: 'u1', password: 'correct horse' }]]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a password shorter than the minimum is not sent', async () => {
    await open();
    await type('x'.repeat(MIN_PASSWORD_LENGTH - 1));
    await act(async () => {
        document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(mutateAsync).not.toHaveBeenCalled();
});

test('a reset the server refuses keeps the dialog open', async () => {
    mutateAsync.mockImplementation(async () => {
        throw new Error('offline');
    });
    await open();
    await act(async () => resetButton()?.click());
    await settle();
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
});

test('every opening suggests a new password', async () => {
    await open();
    await type('correct horse');
    await act(async () => setOpen(false));
    await act(async () => setOpen(true));
    expect(field().value).toMatch(/^[a-zA-Z2-9]{12}$/);
});
