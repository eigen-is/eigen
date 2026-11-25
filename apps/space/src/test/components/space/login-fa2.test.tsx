// The two-factor sign-in step keeps the page rules on both its forms, the app code and the backup code. Pinned beside
// the contract: switching opens the other form on its field, each sends its hook the code and the trust choice, a
// wrong code reads under the field with no toast, an expired sign-in goes back to sign-in with its way back, and any
// other refusal is the hook's toast with no field marked.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

type Verify = (input: { code: string; trustDevice?: boolean }) => Promise<unknown>;
// The hooks' mutateAsync, which resolves and leaves the page by default.
const verifyTotp = { mutateAsync: mock<Verify>(async () => ({})) };
const verifyBackupCode = { mutateAsync: mock<Verify>(async () => ({})) };

const toasts: string[] = [];
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realSonner = { ...(await import('sonner')) };
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    useVerifyTotp: () => verifyTotp,
    useVerifyBackupCode: () => verifyBackupCode,
}));
mock.module('sonner', () => ({
    ...realSonner,
    toast: { ...realSonner.toast, error: (message: string) => toasts.push(message) },
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('sonner', () => realSonner);
});

afterEach(() => {
    for (const hook of [verifyTotp, verifyBackupCode]) {
        hook.mutateAsync.mockReset();
        hook.mutateAsync.mockImplementation(async () => ({}));
    }
    toasts.length = 0;
});

const { act, createElement, useEffect } = await import('react');
const router = await import('@tanstack/react-router');
const { AppError, onMutationError } = await import('@workspace/lib/api-error');
const { LoginFa2Page } = await import('../../../components/space/login-fa2');

// The way back as Mail's `_auth` guard writes it.
const MAIL_INBOX = 'http://localhost:3000/mail/box/inbox';

const NO_GUARD = 'the sign-in step stores nothing that leaving would lose, so it has no leave guard';

test('the app code form keeps the page rules', async () => {
    await expectFormContract({
        kind: 'page',
        render: () => createElement(LoginFa2Page),
        submitLabel: 'Verify',
        firstField: 'Verification code',
        onSubmit: verifyTotp.mutateAsync,
        makeChanged: () => type('Verification code', '123456'),
        makeInvalid: () => type('Verification code', '123'),
        invalidField: 'Verification code',
        except: { leaveGuard: NO_GUARD },
    });
});

test('the backup code form keeps the page rules', async () => {
    await expectFormContract({
        kind: 'page',
        render: () => createElement(AtBackupCode),
        submitLabel: 'Verify with backup code',
        firstField: 'Backup code',
        onSubmit: verifyBackupCode.mutateAsync,
        makeChanged: () => type('Backup code', 'abcde-fghij'),
        makeInvalid: () => type('Backup code', ''),
        invalidField: 'Backup code',
        except: { leaveGuard: NO_GUARD },
    });
});

// The step with "Use a backup code instead" pressed.
function AtBackupCode() {
    useEffect(() => switchButton('Use a backup code instead').click(), []);
    return createElement(LoginFa2Page);
}

test('switching opens the other form on its field', async () => {
    await renderPage();
    await press('Use a backup code instead');
    expect(document.activeElement).toBe(field('Backup code'));
    await press('Use authenticator app instead');
    expect(document.activeElement).toBe(field('Verification code'));
});

// A press focuses a button before it clicks it, as a browser's does.
async function press(label: string) {
    await act(async () => {
        switchButton(label).focus();
        switchButton(label).click();
    });
}

test('each form sends its code and the trust choice', async () => {
    await renderPage();
    await type('Verification code', '123456');
    await act(async () => field('Trust this device').click());
    await act(async () => pressEnter(field('Verification code')));
    expect(verifyTotp.mutateAsync.mock.calls).toEqual([[{ code: '123456', trustDevice: true }]]);

    await act(async () => switchButton('Use a backup code instead').click());
    await type('Backup code', 'abcde-fghij');
    await act(async () => pressEnter(field('Backup code')));
    expect(verifyBackupCode.mutateAsync.mock.calls).toEqual([[{ code: 'abcde-fghij', trustDevice: false }]]);
});

test('a wrong code reads under the field, with no toast', async () => {
    // The hook raises no toast for a wrong code, and the form shows better-auth's words.
    verifyTotp.mutateAsync.mockImplementation(async () => {
        throw new AppError({ status: 401, error: { status: 401, value: 'Invalid code' } });
    });
    await renderPage();
    await type('Verification code', '123456');
    await act(async () => pressEnter(field('Verification code')));
    expect(messageUnder('Verification code')).toBe('Invalid code');
    expect(document.activeElement).toBe(field('Verification code'));
    expect(toasts).toEqual([]);
});

test('an expired sign-in goes back to sign-in, keeping the way back', async () => {
    verifyTotp.mutateAsync.mockImplementation(async () => {
        throw new AppError({
            status: 401,
            error: { status: 401, value: { message: 'Invalid two factor cookie', code: 'INVALID_TWO_FACTOR_COOKIE' } },
        });
    });
    const memory = await renderPage(MAIL_INBOX);
    await type('Verification code', '123456');
    await act(async () => pressEnter(field('Verification code')));
    expect(memory.state.location.pathname).toBe('/login');
    expect(memory.state.location.search).toEqual({ redirect: MAIL_INBOX });
    expect(messageUnder('Verification code')).toBeUndefined();
});

test('a right code goes back to the page in the app that sent the user to sign in', async () => {
    await renderPage(MAIL_INBOX);
    await type('Verification code', '123456');
    await act(async () => pressEnter(field('Verification code')));
    expect(window.location.href).toBe(MAIL_INBOX);
});

// Bun fails a test on an unhandled rejection, as the browser raises a page error on one.
test('any other refusal is the hook toast, with no field marked', async () => {
    verifyBackupCode.mutateAsync.mockImplementation(async () => {
        const locked = new AppError({ status: 429, error: { status: 429, value: 'Account temporarily locked' } });
        onMutationError(locked);
        throw locked;
    });
    await renderPage();
    await act(async () => switchButton('Use a backup code instead').click());
    await type('Backup code', 'abcde-fghij');
    await act(async () => pressEnter(field('Backup code')));
    expect(toasts).toEqual(['Account temporarily locked']);
    expect(field('Backup code').getAttribute('aria-invalid')).toBe('false');
});

async function renderPage(redirect?: string) {
    const root = router.createRootRoute({ component: () => createElement(LoginFa2Page, { redirect }) });
    const memory = router.createRouter({
        routeTree: root,
        history: router.createMemoryHistory({ initialEntries: ['/'] }),
    });
    await memory.load();
    await renderInDocument(createElement(router.RouterProvider, { router: memory }));
    return memory;
}

function switchButton(label: string): HTMLButtonElement {
    const found = [...document.querySelectorAll('button')].find((button) => button.textContent === label);
    if (!found) throw new Error(`no ${label} button`);
    return found;
}

function field(label: string): HTMLElement {
    const tag = [...document.querySelectorAll('label')].find((element) => element.textContent === label);
    const control = tag?.htmlFor ? document.getElementById(tag.htmlFor) : null;
    if (!(control instanceof HTMLElement)) throw new Error(`no field labelled ${label}`);
    return control;
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
