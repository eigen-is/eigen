// better-auth refuses with a plain object, so the app password hooks turn it into an AppError with its status and
// words. The toast then reads the server's message instead of "[object Object]", and a dialog can tell a refusal.
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { AppError, isRefusal } from '../../../../core/api-error';
import { appPasswordKeys } from '../../../../core/auth/hooks/keys';
import { installHappyDom } from '../../../happy-dom';
import { renderHook } from '../../../render-hook';

installHappyDom();

const REFUSED = { data: null, error: { status: 403, statusText: 'Forbidden', message: 'Not your app password' } };
const refuse = async () => REFUSED;

const realClientModule = { ...(await import('../../../../core/auth/hooks/use-auth-client')) };
mock.module('../../../../core/auth/hooks/use-auth-client', () => ({
    authClient: { apiKey: { list: refuse, create: refuse, delete: refuse } },
}));

const realAuthContext = { ...(await import('../../../../core/auth/auth-context')) };
mock.module('../../../../core/auth/auth-context', () => ({
    ...realAuthContext,
    useAuth: () => ({ user: { id: 'u1' } }),
}));

const toasts: string[] = [];
const realSonner = { ...(await import('sonner')) };
mock.module('sonner', () => ({
    ...realSonner,
    toast: { ...realSonner.toast, error: (message: string) => toasts.push(message) },
}));

afterAll(() => {
    mock.module('../../../../core/auth/hooks/use-auth-client', () => realClientModule);
    mock.module('../../../../core/auth/auth-context', () => realAuthContext);
    mock.module('sonner', () => realSonner);
});

const { useAppPasswords, useCreateAppPassword, useDeleteAppPassword } = await import(
    '../../../../core/auth/hooks/use-app-passwords'
);

beforeEach(() => {
    toasts.length = 0;
});

const expectRefusal = (error: unknown) => {
    expect(error).toBeInstanceOf(AppError);
    expect(error instanceof AppError && [error.status, error.message]).toEqual([403, 'Not your app password']);
    expect(isRefusal(error)).toBe(true);
};

test('a refused list fails with the status and the words', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = await renderHook(useAppPasswords, client);
    const query = client.getQueryCache().find({ queryKey: appPasswordKeys.list('u1') });
    while (query?.state.status === 'pending') await new Promise((settle) => setTimeout(settle, 1));
    await unmount();
    expectRefusal(query?.state.error);
});

const mutations: [string, () => { mutateAsync: (input: string) => Promise<unknown> }, string][] = [
    ['create', useCreateAppPassword, 'Thunderbird'],
    ['delete', useDeleteAppPassword, 'key-1'],
];
for (const [name, use, input] of mutations) {
    test(`a refused ${name} is a toast in the server's words, and reads as a refusal`, async () => {
        const { latest, unmount } = await renderHook(use, new QueryClient());
        const error = await latest.mutateAsync(input).catch((caught: unknown) => caught);
        await unmount();
        expectRefusal(error);
        expect(toasts).toEqual(['Not your app password']);
    });
}
