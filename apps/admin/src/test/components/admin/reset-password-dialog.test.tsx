// Reset password keeps the dialog contract and suggests a random password on every opening, which the admin may
// edit, and sets it for the user. The dialog says the user is signed out everywhere, and a password shorter than the
// minimum says so under the field and is not sent.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { MIN_PASSWORD_LENGTH } from '@workspace/lib/validation';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

type ResetInput = { userId: string; password: string };
const resetPassword = mock(async (_input: ResetInput) => {});
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAdmin = { ...(await import('@workspace/lib/admin')) };
mock.module('@workspace/lib/admin', () => ({
    ...realAdmin,
    useResetUserPassword: () => ({ mutateAsync: resetPassword, isPending: false }),
}));
afterAll(() => {
    mock.module('@workspace/lib/admin', () => realAdmin);
});

const { act, createElement, useState } = await import('react');
const { ResetPasswordDialog } = await import('../../../components/admin/reset-password-dialog');

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => resetPassword.mockClear());

// The dialog under a parent that owns `open`, as the user page does, so a test can close and reopen it.
let setOpen = (_open: boolean) => {};
function Toolbar() {
    const [open, setOpenState] = useState(true);
    setOpen = setOpenState;
    return createElement(ResetPasswordDialog, { open, onOpenChange: setOpenState, userId: 'u1', userName: 'Ada' });
}

const field = () => {
    const tag = [...document.querySelectorAll('label')].find((l) => l.textContent === 'New password');
    const input = tag && document.getElementById(tag.htmlFor);
    if (!(input instanceof HTMLInputElement)) throw new Error('no field labelled New password');
    return input;
};
// React reads the value off its own tracker, so the native setter is what a keystroke looks like.
const type = (value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field(), value);
        field().dispatchEvent(new Event('input', { bubbles: true }));
    });
const reset = () =>
    act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Reset password')?.click());

test('Reset password keeps the dialog contract', async () => {
    await expectFormContract({
        kind: 'dialog',
        render: () => createElement(Toolbar),
        submitLabel: 'Reset password',
        firstField: 'New password',
        onSubmit: resetPassword,
        makeChanged: () => type('correct horse'),
        makeInvalid: () => type('short'),
        invalidField: 'New password',
    });
});

test('it names the user, says they are signed out, and suggests a password of twelve characters', async () => {
    ({ unmount } = await renderInDocument(createElement(Toolbar)));
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Reset password for Ada');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        'They are signed out everywhere. Share the new password with them securely.',
    );
    expect(field().value).toMatch(/^[a-zA-Z2-9]{12}$/);
});

test('Reset password sets the edited password for the user, and the dialog closes', async () => {
    ({ unmount } = await renderInDocument(createElement(Toolbar)));
    await type('correct horse');
    await reset();
    expect(resetPassword.mock.calls).toEqual([[{ userId: 'u1', password: 'correct horse' }]]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test('a password shorter than the minimum says so under the field and is not sent', async () => {
    ({ unmount } = await renderInDocument(createElement(Toolbar)));
    await type('x'.repeat(MIN_PASSWORD_LENGTH - 1));
    await reset();
    expect(resetPassword).not.toHaveBeenCalled();
    expect(document.querySelector('[data-slot="field-error"]')?.textContent).toBe(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
});

test('every opening suggests a new password', async () => {
    ({ unmount } = await renderInDocument(createElement(Toolbar)));
    await type('correct horse');
    await act(async () => setOpen(false));
    await act(async () => setOpen(true));
    expect(field().value).toMatch(/^[a-zA-Z2-9]{12}$/);
});
