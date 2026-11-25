// Change password sends the change once: while the server answers, the button reads "Changing password..." and takes
// no second Enter or click. A done change returns to Space's start page; a refused one shows its toast and the form
// can try again. A too-short new password says so, and stops saying so once the password is long enough.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom().happyDOM.setViewport({ width: 1440, height: 900 });

// The change, stubbed and held until the test lets the server answer: one object, so the effects that depend on it settle.
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
let answered = Promise.withResolvers<void>();
const toasts: string[] = [];
const changePassword = {
    mutateAsync: mock(async (_data: { currentPassword: string; newPassword: string; revokeOtherSessions: boolean }) => {
        // What the hook's mutateAsync does on a refusal: its onError toasts, and the promise still rejects.
        await answered.promise.catch((error: unknown) => {
            onMutationError(error);
            throw error;
        });
    }),
};
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realSonner = { ...(await import('sonner')) };
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    useAuth: () => session,
    useChangePassword: () => changePassword,
}));
mock.module('sonner', () => ({
    ...realSonner,
    toast: { ...realSonner.toast, error: (message: string) => toasts.push(message) },
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('sonner', () => realSonner);
});

const { act, createElement } = await import('react');
const { onMutationError } = await import('@workspace/lib/api-error');
const { createMemoryHistory, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { UploadProvider } = await import('@workspace/ui/components/upload-provider');
const { routeTree } = await import('../../routeTree.gen');

const auth = {
    isAuthenticated: true,
    isLoading: false,
    user: { ...session.user, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    login: async () => ({ success: true }),
    logout: async () => {},
};

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    answered = Promise.withResolvers<void>();
    changePassword.mutateAsync.mockClear();
    toasts.length = 0;
});

async function open() {
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: ['/security/password'] }),
        context: { auth },
    });
    await router.load();
    const rendered = await renderInDocument(
        createElement(UploadProvider, null, createElement(RouterProvider, { router })),
    );
    unmount = rendered.unmount;
    return { pathname: () => router.state.location.pathname };
}

function field(label: string): HTMLInputElement {
    const element = [...document.querySelectorAll('label')].find((l) => l.textContent === label);
    const input = element && document.getElementById(element.htmlFor);
    if (!(input instanceof HTMLInputElement)) throw new Error(`no field labelled ${label}`);
    return input;
}

const type = (input: HTMLInputElement, value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });

const submitButton = () => document.querySelector<HTMLButtonElement>('button[type="submit"]');

test('a second Enter while the change is on its way sends nothing', async () => {
    const page = await open();
    await type(field('Current password'), 'old-password-123');
    await type(field('New password'), 'new-password-456');
    await type(field('Confirm new password'), 'new-password-456');

    await act(async () => pressEnter(field('Confirm new password')));
    expect(submitButton()?.disabled).toBe(true);
    expect(submitButton()?.textContent).toBe('Changing password...');
    await act(async () => pressEnter(field('Confirm new password')));
    expect(changePassword.mutateAsync).toHaveBeenCalledTimes(1);

    await act(async () => answered.resolve());
    expect(page.pathname()).toBe('/');
});

// Bun fails a test on an unhandled rejection, as the browser raises a page error on one.
test('a refused change shows its toast, stays on the page and enables the button again', async () => {
    const page = await open();
    await type(field('Current password'), 'wrong-password');
    await type(field('New password'), 'new-password-456');
    await type(field('Confirm new password'), 'new-password-456');

    await act(async () => pressEnter(field('Confirm new password')));
    await act(async () => answered.reject(new Error('Invalid password')));
    await act(async () => void (await Bun.sleep(0)));
    expect(toasts).toEqual(['Invalid password']);
    expect(page.pathname()).toBe('/security/password');
    expect(submitButton()?.disabled).toBe(false);
    expect(submitButton()?.textContent).toBe('Change password');
});

test('a too-short new password says so until it is long enough', async () => {
    await open();
    const tooShort = () => document.body.textContent?.includes('Password must be at least 8 characters') ?? false;
    await type(field('Current password'), 'old-password-123');
    await type(field('Confirm new password'), 'long-enough-password');
    await type(field('New password'), 'short');
    await act(async () => submitButton()?.click());
    expect(tooShort()).toBe(true);

    await type(field('New password'), 'long-enough-password');
    expect(tooShort()).toBe(false);
});
