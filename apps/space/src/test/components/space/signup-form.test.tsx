// Invite sign-up keeps the page rules: it opens on Name, Enter creates the account once, Create account spins while it
// runs, and each problem reads under its own field instead of a browser bubble or a banner. Pinned beside the
// contract: it sends the invite route the name, the username in lower case and the password, as before.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const register = { mutateAsync: mock(async (_body: { name: string; username: string; password: string }) => ({})) };
afterEach(() => register.mutateAsync.mockClear());

// A copy, because mock.module rewrites a loaded module's exports in place, and afterAll puts the original back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useInviteRegister: () => register }));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
});

const { act, createElement } = await import('react');
const { SignupForm } = await import('../../../components/space/signup-form');

const form = () => createElement(SignupForm, { token: 'invite-token', mailDomain: 'tuimel.example' });

const fillIn = async () => {
    await type('Name', 'Ada Lovelace');
    await type('Username', 'Ada');
    await type('Password', 'long-enough-password');
    await type('Confirm password', 'long-enough-password');
};

test('invite sign-up keeps the page rules', async () => {
    await expectFormContract({
        kind: 'page',
        render: form,
        submitLabel: 'Create account',
        firstField: 'Name',
        onSubmit: register.mutateAsync,
        makeChanged: fillIn,
        makeInvalid: async () => {},
        invalidField: 'Name',
        modEnterFields: ['Confirm password'],
        except: { leaveGuard: 'sign-up stores nothing that leaving would lose, so it has no leave guard' },
    });
});

test('sends the name, the username in lower case and the password', async () => {
    await renderInDocument(form());
    await fillIn();
    await act(async () => pressEnter(field('Confirm password')));
    expect(register.mutateAsync.mock.calls).toEqual([
        [{ name: 'Ada Lovelace', username: 'ada', password: 'long-enough-password' }],
    ]);
});

test('each problem reads under its own field, and nothing is sent', async () => {
    await renderInDocument(form());
    await type('Name', 'Ada Lovelace');
    await type('Username', 'a');
    await type('Password', 'short');
    await type('Confirm password', 'other');
    await act(async () => pressEnter(field('Name')));

    expect(messageUnder('Name')).toBeUndefined();
    expect(messageUnder('Username')).toBe('Username must be 2-30 characters');
    expect(messageUnder('Password')).toBe('Password must be at least 8 characters');
    expect(messageUnder('Confirm password')).toBe('Passwords do not match');
    expect(document.activeElement).toBe(field('Username'));
    expect(register.mutateAsync).not.toHaveBeenCalled();
});

function field(label: string): HTMLInputElement {
    const tag = [...document.querySelectorAll('label')].find((element) => element.textContent === label);
    const input = tag?.htmlFor ? document.getElementById(tag.htmlFor) : null;
    if (!(input instanceof HTMLInputElement)) throw new Error(`no field labelled ${label}`);
    return input;
}

function messageUnder(label: string): string | undefined {
    const id = field(label).getAttribute('aria-describedby')?.split(' ').at(-1);
    const message = id ? document.getElementById(id) : null;
    return message?.dataset.slot === 'form-message' ? (message.textContent ?? undefined) : undefined;
}

// React reads the value off its own tracker, so the native setter is what a keystroke looks like.
async function type(label: string, value: string) {
    const input = field(label);
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
