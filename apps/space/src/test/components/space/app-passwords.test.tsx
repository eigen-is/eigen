// The app password form keeps the page rules: Enter generates once, Generate spins while it runs, and an empty name
// says so under the field. Pinned beside the contract: the new password shows once with the name cleared, and a delete
// asks first, since a deleted password can't be brought back.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const createAppPassword = { mutateAsync: mock(async (_name: string) => ({ key: 'eigen_secret_key' })) };
const deleteAppPassword = { mutateAsync: mock(async (_keyId: string) => ({ success: true })) };
const PASSWORDS = [{ id: 'k1', name: 'Thunderbird', createdAt: new Date('2026-11-01'), lastRequest: null }];
afterEach(() => {
    createAppPassword.mutateAsync.mockClear();
    deleteAppPassword.mutateAsync.mockClear();
});

// A copy, because mock.module rewrites a loaded module's exports in place, and afterAll puts the original back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    useAppPasswords: () => ({ data: PASSWORDS, isLoading: false }),
    useCreateAppPassword: () => createAppPassword,
    useDeleteAppPassword: () => deleteAppPassword,
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
});

const { act, createElement } = await import('react');
const { AppPasswords } = await import('../../../components/space/app-passwords');

test('the app password form keeps the page rules', async () => {
    await expectFormContract({
        kind: 'page',
        render: () => createElement(AppPasswords),
        submitLabel: 'Generate',
        firstField: 'Name',
        onSubmit: createAppPassword.mutateAsync,
        makeChanged: () => typeName('Thunderbird'),
        makeInvalid: async () => {},
        invalidField: 'Name',
        noDraft: true,
        except: { focus: 'the form sits far down the Integrations page, so it takes no focus as the page opens' },
    });
});

test('Generate shows the new password once and clears the name', async () => {
    await renderInDocument(createElement(AppPasswords));
    await typeName('  Thunderbird ');
    await act(async () => pressEnter(nameField()));
    expect(createAppPassword.mutateAsync.mock.calls).toEqual([['Thunderbird']]);
    expect(document.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe('eigen_secret_key');
    expect(nameField().value).toBe('');
});

test('a delete asks first, and only Delete removes the password', async () => {
    await renderInDocument(createElement(AppPasswords));
    await act(async () => trash().click());
    expect(deleteAppPassword.mutateAsync).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Thunderbird');

    await act(async () => button('Cancel').click());
    expect(deleteAppPassword.mutateAsync).not.toHaveBeenCalled();

    await act(async () => trash().click());
    await act(async () => button('Delete').click());
    expect(deleteAppPassword.mutateAsync.mock.calls).toEqual([['k1']]);
});

const trash = () => {
    const found = document.querySelector<HTMLButtonElement>('table button');
    if (!found) throw new Error('no delete button');
    return found;
};

function button(label: string): HTMLButtonElement {
    const found = [...document.querySelectorAll('button')].filter((b) => b.textContent === label).at(-1);
    if (!found) throw new Error(`no ${label} button`);
    return found;
}

function nameField(): HTMLInputElement {
    const tag = [...document.querySelectorAll('label')].find((element) => element.textContent === 'Name');
    const input = tag?.htmlFor ? document.getElementById(tag.htmlFor) : null;
    if (!(input instanceof HTMLInputElement)) throw new Error('no Name field');
    return input;
}

// React reads the value off its own tracker, so the native setter is what a keystroke looks like.
const typeName = (value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(nameField(), value);
        nameField().dispatchEvent(new Event('input', { bubbles: true }));
    });
