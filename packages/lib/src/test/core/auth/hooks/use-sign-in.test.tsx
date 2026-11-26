// A member's sign-in sends better-auth the address and password as typed. Wrong credentials are the form's to show
// under the password, so the hook raises no toast for them; a rate limit, a server error or no connection is a toast,
// in better-auth's words where it gave some.
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { installHappyDom } from '../../../happy-dom';
import { renderHook } from '../../../render-hook';

installHappyDom();

let answer: () => Promise<{ data: unknown; error: unknown }> = async () => ({ data: null, error: null });
const sent: { email: string; password: string }[] = [];

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realClientModule = { ...(await import('../../../../core/auth/hooks/use-auth-client')) };
mock.module('../../../../core/auth/hooks/use-auth-client', () => ({
    authClient: {
        getSession: async () => ({ data: null }),
        signIn: {
            email: (input: { email: string; password: string }) => {
                sent.push(input);
                return answer();
            },
        },
    },
}));

const toasts: string[] = [];
const realSonner = { ...(await import('sonner')) };
mock.module('sonner', () => ({
    ...realSonner,
    toast: { ...realSonner.toast, error: (message: string) => toasts.push(message) },
}));

afterAll(() => {
    mock.module('../../../../core/auth/hooks/use-auth-client', () => realClientModule);
    mock.module('sonner', () => realSonner);
});

const { createElement } = await import('react');
const { AuthProvider } = await import('../../../../core/auth/auth-context');
const { isRefusedCredentials, usePasswordSignIn } = await import('../../../../core/auth/hooks/use-sign-in');

beforeEach(() => {
    sent.length = 0;
    toasts.length = 0;
});

async function signIn(): Promise<unknown> {
    const { latest, unmount } = await renderHook(usePasswordSignIn, new QueryClient(), (children) =>
        createElement(AuthProvider, null, children),
    );
    const error = await latest
        .mutateAsync({ email: 'anouk@tuimel.example', password: 'secret' })
        .catch((caught: unknown) => caught);
    await unmount();
    return error;
}

test('sends the address and password, and a wrong password raises no toast', async () => {
    answer = async () => ({ data: null, error: { status: 401, message: 'Invalid email or password' } });
    const error = await signIn();
    expect(sent).toEqual([{ email: 'anouk@tuimel.example', password: 'secret' }]);
    expect(isRefusedCredentials(error)).toBe(true);
    expect(error instanceof Error && error.message).toBe('Invalid email or password');
    expect(toasts).toEqual([]);
});

for (const [what, failure, toast] of [
    [
        'a rate limit',
        { status: 429, statusText: 'Too Many Requests', message: 'Too many requests' },
        'Too many requests',
    ],
    [
        'a server error',
        { status: 500, statusText: 'Internal Server Error', message: 'Database locked' },
        'Database locked',
    ],
] as const) {
    test(`${what} is a toast in better-auth's words`, async () => {
        answer = async () => ({ data: null, error: failure });
        const error = await signIn();
        expect(isRefusedCredentials(error)).toBe(false);
        expect(toasts).toEqual([toast]);
    });
}

test('no connection is a toast', async () => {
    answer = async () => {
        throw new TypeError('Failed to fetch');
    };
    const error = await signIn();
    expect(isRefusedCredentials(error)).toBe(false);
    expect(toasts).toEqual(['Login failed']);
});
