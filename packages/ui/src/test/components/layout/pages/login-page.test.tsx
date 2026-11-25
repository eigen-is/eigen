// The sign-in page keeps the page rules on its three forms: username and password, a guest's email, and the code the
// guest was sent. Pinned beside the contract: a click on a tab goes on into its first field, a refusal reads under the
// field it is about rather than in a banner, and each form still sends the auth routes exactly what it sent before.
import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { ReactElement } from 'react';
import { installHappyDom } from '../../../happy-dom';
import { pressEnter } from '../../../press-enter';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

type LoginResult = { success: boolean; error?: unknown };

const login = mock(async (_email: string, _password: string): Promise<LoginResult> => ({ success: true }));

const realAuth = { ...(await import('@workspace/lib/auth')) };
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ login, isAuthenticated: false }) }));
mock.module('@workspace/lib/public', () => ({
    ...realPublic,
    usePublicConfig: () => ({ data: { mailDomain: 'tuimel.example', demoMode: false }, isPending: false }),
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/public', () => realPublic);
});

// What each guest route answers; a test sets a refusal.
let answers: Record<string, () => Response> = {};
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
        async (input: string | URL | Request) =>
            answers[String(input).split('/guest-auth/')[1] ?? '']?.() ?? new Response(null, { status: 200 }),
        { preconnect: fetch.preconnect },
    ),
);
afterEach(() => {
    answers = {};
    fetchSpy.mockClear();
    login.mockClear();
});
afterAll(() => fetchSpy.mockRestore());

const refusal = (message: string) => () =>
    new Response(JSON.stringify(message), { status: 400, headers: { 'Content-Type': 'application/json' } });

const { act, createElement } = await import('react');
const router = await import('@tanstack/react-router');
const { expectFormContract } = await import('../../../form-contract');
const { LoginPage } = await import('../../../../components/layout/pages/login-page');

const NO_GUARD = 'sign-in stores nothing that leaving would lose, so it has no leave guard';

test('the password form keeps the page rules', async () => {
    await expectFormContract({
        kind: 'page',
        render: () => <LoginPage />,
        submitLabel: 'Sign in',
        firstField: 'Username',
        onSubmit: login,
        makeChanged: async () => {
            await type('Username', 'anouk');
            await type('Password', 'secret');
        },
        makeInvalid: async () => {},
        invalidField: 'Username',
        modEnterFields: ['Password'],
        except: { leaveGuard: NO_GUARD },
    });
});

test("the guest's email form keeps the page rules", async () => {
    const requestCode = mock(() => new Response(null, { status: 200 }));
    answers['request-otp'] = requestCode;
    await expectFormContract({
        kind: 'page',
        render: () => <LoginPage email="joris@example.com" />,
        submitLabel: 'Send code',
        firstField: 'Email',
        onSubmit: requestCode,
        makeChanged: () => type('Email', 'ada@example.com'),
        makeInvalid: () => type('Email', 'nobody'),
        invalidField: 'Email',
        except: { leaveGuard: NO_GUARD },
    });
});

test('a click on a tab goes on into its first field', async () => {
    await renderPage(<LoginPage />);
    await clickTab('Guest');
    expect(document.activeElement).toBe(field('Email'));
    await clickTab('Sign in');
    expect(document.activeElement).toBe(field('Username'));
});

test('sends the username at the mail domain, and a wrong password reads under the password', async () => {
    login.mockImplementationOnce(async () => ({ success: false, error: { status: 401, message: 'Invalid' } }));
    await renderPage(<LoginPage />);
    await type('Username', 'Anouk');
    await type('Password', 'wrong');
    await act(async () => pressEnter(field('Password')));

    expect(login.mock.calls).toEqual([['anouk@tuimel.example', 'wrong']]);
    expect(messageUnder('Password')).toBe('Login failed');
    expect(field('Password').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(field('Password'));
    expect(messageUnder('Username')).toBeUndefined();
});

test("a guest's code goes to the address it was sent to, and each refusal reads under its field", async () => {
    answers['request-otp'] = refusal('No shared resources found for this email');
    await renderPage(<LoginPage email="joris@example.com" />);
    await act(async () => pressEnter(field('Email')));
    expect(messageUnder('Email')).toBe('No shared resources found for this email');
    expect(document.activeElement).toBe(field('Email'));

    delete answers['request-otp'];
    await act(async () => pressEnter(field('Email')));
    expect(document.activeElement).toBe(field('One-time code'));

    await type('One-time code', '123');
    await act(async () => pressEnter(field('One-time code')));
    expect(messageUnder('One-time code')).toBe('Code must be 6 digits');

    answers['verify-otp'] = refusal('Invalid or expired code');
    await type('One-time code', '123456');
    await act(async () => pressEnter(field('One-time code')));
    expect(messageUnder('One-time code')).toBe('Invalid or expired code');
    expect(document.activeElement).toBe(field('One-time code'));

    const sent = fetchSpy.mock.calls.map(([url, init]) => [String(url).split('/guest-auth/')[1], init]);
    expect(sent).toEqual([
        ['request-otp', post({ email: 'joris@example.com' })],
        ['request-otp', post({ email: 'joris@example.com' })],
        ['verify-otp', { ...post({ email: 'joris@example.com', otp: '123456' }), credentials: 'include' }],
    ]);
});

const post = (body: object) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

// In a memory router, as every app's /login route renders it.
async function renderPage(element: ReactElement) {
    const root = router.createRootRoute({ component: () => element });
    const memory = router.createRouter({
        routeTree: root,
        history: router.createMemoryHistory({ initialEntries: ['/'] }),
    });
    await memory.load();
    await renderInDocument(createElement(router.RouterProvider, { router: memory }));
}

// As a browser clicks: Radix switches the tab on the press, then the press focuses the tab, then the click lands.
async function clickTab(label: string) {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((element) => element.textContent === label);
    if (!(tab instanceof HTMLElement)) throw new Error(`no ${label} tab`);
    await act(async () => {
        tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    });
    await act(async () => {
        tab.focus();
        tab.click();
    });
}

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
