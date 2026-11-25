// The two-factor page's forms keep the page rules: the password that turns it on, the code that checks the app, and
// the password that turns it off. Pinned beside the contract: each sends its hook what it sent before, a wrong code
// reads under its field with no toast, a copy of the recovery codes the browser refuses is a toast, and leaving the
// recovery codes asks first, while "I've saved my recovery codes" leaves without asking.
import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const SECRET = { totpURI: 'otpauth://totp/Eigen:me?secret=ABC', backupCodes: ['aaaaa-11111', 'bbbbb-22222'] };
const initialize2FA = { mutateAsync: mock(async (_password: string) => SECRET) };
const verifyTotp = {
    mutateAsync: mock(async (_input: { code: string; trustDevice?: boolean }): Promise<unknown> => ({})),
};
const disable2FA = { mutateAsync: mock(async (_password: string) => ({})) };

const toasts: string[] = [];
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realSonner = { ...(await import('sonner')) };
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    useInitialize2FA: () => initialize2FA,
    useVerifyTotp: () => verifyTotp,
    useDisable2FA: () => disable2FA,
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
    verifyTotp.mutateAsync.mockReset();
    verifyTotp.mutateAsync.mockImplementation(async () => ({}));
    for (const hook of [initialize2FA, disable2FA]) hook.mutateAsync.mockClear();
    toasts.length = 0;
});

const { act, createElement, useEffect } = await import('react');
const router = await import('@tanstack/react-router');
const { AppError } = await import('@workspace/lib/api-error');
const { TwoFactorCodesStep, TwoFactorDisable, TwoFactorPasswordStep, TwoFactorVerifyStep } = await import(
    '../../../components/space/fa2'
);

test('the password that turns two-factor on keeps the page rules', async () => {
    await expectFormContract({
        kind: 'page',
        render: () => createElement(TwoFactorPasswordStep, { onEnabled: () => {} }),
        submitLabel: 'Enable two-factor authentication',
        firstField: 'Current password',
        onSubmit: initialize2FA.mutateAsync,
        makeChanged: () => type('Current password', 'secret-password'),
        makeInvalid: () => type('Current password', ''),
        invalidField: 'Current password',
        noDraft: true,
    });
});

test('the code that checks the app keeps the page rules', async () => {
    await expectFormContract({
        kind: 'page',
        render: () => createElement(TwoFactorVerifyStep, { onBack: () => {}, onVerified: () => {} }),
        submitLabel: 'Verify and enable',
        firstField: 'Verification code',
        onSubmit: verifyTotp.mutateAsync,
        makeChanged: () => type('Verification code', '123456'),
        makeInvalid: () => type('Verification code', '123'),
        invalidField: 'Verification code',
        noDraft: true,
    });
});

test('the password that turns two-factor off keeps the page rules', async () => {
    await expectFormContract({
        kind: 'page',
        render: () => createElement(DisableOpen),
        submitLabel: 'Disable',
        firstField: 'Confirm your password',
        onSubmit: disable2FA.mutateAsync,
        makeChanged: () => type('Confirm your password', 'secret-password'),
        makeInvalid: () => type('Confirm your password', ''),
        invalidField: 'Confirm your password',
        noDraft: true,
    });
});

// The disable form, opened by its button.
function DisableOpen() {
    useEffect(() => button('Disable two-factor authentication').click(), []);
    return createElement(TwoFactorDisable, { onDisabled: () => {} });
}

test('each form sends its hook what it sent before', async () => {
    const enabled = mock();
    await renderAt(createElement(TwoFactorPasswordStep, { onEnabled: enabled }));
    await type('Current password', 'secret-password');
    await act(async () => pressEnter(field('Current password')));
    expect(initialize2FA.mutateAsync.mock.calls).toEqual([['secret-password']]);
    expect(enabled.mock.calls).toEqual([[SECRET]]);

    const verified = mock();
    await renderAt(createElement(TwoFactorVerifyStep, { onBack: () => {}, onVerified: verified }));
    await type('Verification code', '123456');
    await act(async () => pressEnter(field('Verification code')));
    expect(verifyTotp.mutateAsync.mock.calls).toEqual([[{ code: '123456' }]]);
    expect(verified).toHaveBeenCalledTimes(1);

    const disabled = mock();
    await renderAt(createElement(TwoFactorDisable, { onDisabled: disabled }));
    await act(async () => button('Disable two-factor authentication').click());
    await type('Confirm your password', 'secret-password');
    await act(async () => pressEnter(field('Confirm your password')));
    expect(disable2FA.mutateAsync.mock.calls).toEqual([['secret-password']]);
    expect(disabled).toHaveBeenCalledTimes(1);
});

test('a wrong code reads under its field, with no toast, and the step stays', async () => {
    verifyTotp.mutateAsync.mockImplementation(async () => {
        throw new AppError({ status: 401, error: { status: 401, value: 'Invalid code' } });
    });
    const verified = mock();
    await renderAt(createElement(TwoFactorVerifyStep, { onBack: () => {}, onVerified: verified }));
    await type('Verification code', '123456');
    await act(async () => pressEnter(field('Verification code')));
    expect(messageUnder('Verification code')).toBe('Invalid code');
    expect(document.activeElement).toBe(field('Verification code'));
    expect(toasts).toEqual([]);
    expect(verified).not.toHaveBeenCalled();
});

test('leaving the recovery codes asks first, and the saved button leaves without asking', async () => {
    const page = await renderAt(createElement(TwoFactorCodesStep, { backupCodes: SECRET.backupCodes }));
    await act(async () => page.history.push('/'));
    expect(page.at()).toBe(SETUP);
    expect(document.body.textContent).toContain('Leave without your recovery codes?');
    await act(async () => button('Stay').click());
    expect(page.at()).toBe(SETUP);

    await act(async () => button("I've saved my recovery codes").click());
    expect(page.at()).toBe('/');
});

// Bun fails a test on an unhandled rejection, as the browser raises a page error on one.
test('a copy of the recovery codes the browser refuses is a toast', async () => {
    const writeText = spyOn(navigator.clipboard, 'writeText').mockImplementation(async () => {
        throw new DOMException('Write permission denied', 'NotAllowedError');
    });
    await renderAt(createElement(TwoFactorCodesStep, { backupCodes: SECRET.backupCodes }));
    await act(async () => button('Copy all codes').click());
    expect(writeText.mock.calls).toEqual([['aaaaa-11111\nbbbbb-22222']]);
    expect(toasts).toEqual(['Write permission denied']);
    writeText.mockRestore();
});

const SETUP = '/security/2fa';

// In a memory router at the two-factor page, which can leave for Space's start page.
async function renderAt(element: ReturnType<typeof createElement>) {
    const root = router.createRootRoute({ component: router.Outlet });
    const here = router.createRoute({ getParentRoute: () => root, path: SETUP, component: () => element });
    const start = router.createRoute({ getParentRoute: () => root, path: '/', component: () => 'Start' });
    const memory = router.createRouter({
        routeTree: root.addChildren([here, start]),
        history: router.createMemoryHistory({ initialEntries: [SETUP] }),
    });
    await memory.load();
    await renderInDocument(createElement(router.RouterProvider, { router: memory }));
    return { history: memory.history, at: () => memory.state.location.pathname };
}

function button(label: string): HTMLButtonElement {
    const found = [...document.querySelectorAll('button')].filter((b) => b.textContent === label).at(-1);
    if (!found) throw new Error(`no ${label} button`);
    return found;
}

function field(label: string): HTMLInputElement {
    const tag = [...document.querySelectorAll('label')].filter((element) => element.textContent === label).at(-1);
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
