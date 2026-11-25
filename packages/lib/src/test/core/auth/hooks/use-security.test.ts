// A wrong two-factor code is the form's to show under its field, so its verify hooks raise no toast for it, for the
// sign-in step and for two-factor setup alike. A sign-in step that has expired answers 401 too, but with its own code,
// and is a toast that says so. Every other refusal, such as a locked account, is a toast, and each carries
// better-auth's status and message.
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { AppError } from '../../../../core/api-error';
import { installHappyDom } from '../../../happy-dom';
import { renderHook } from '../../../render-hook';

installHappyDom();

type Answer = { data: { token: string } | null; error: { status: number; message?: string; code?: string } | null };
let answer: Answer = { data: { token: 't' }, error: null };
const sent: { code: string; trustDevice?: boolean }[] = [];
const verify = async (input: { code: string; trustDevice?: boolean }) => {
    sent.push(input);
    return answer;
};

const realClientModule = await import('../../../../core/auth/hooks/use-auth-client');
mock.module('../../../../core/auth/hooks/use-auth-client', () => ({
    authClient: { twoFactor: { verifyTotp: verify, verifyBackupCode: verify } },
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

const { isExpiredSignIn, isWrongCode, useVerifyBackupCode, useVerifyTotp } = await import(
    '../../../../core/auth/hooks/use-security'
);

beforeEach(() => {
    answer = { data: { token: 't' }, error: null };
    sent.length = 0;
    toasts.length = 0;
});

async function failure(
    use: () => { mutateAsync: (input: { code: string; trustDevice?: boolean }) => Promise<unknown> },
): Promise<unknown> {
    const { latest, unmount } = await renderHook(use, new QueryClient());
    const error = await latest.mutateAsync({ code: '123456', trustDevice: true }).catch((caught: unknown) => caught);
    await unmount();
    return error;
}

for (const [name, use] of [
    ['app code', useVerifyTotp],
    ['backup code', useVerifyBackupCode],
] as const) {
    test(`${name}: a wrong code raises no toast, and says why for its field`, async () => {
        answer = { data: null, error: { status: 401, message: 'Invalid code' } };
        const error = await failure(use);
        expect(sent).toEqual([{ code: '123456', trustDevice: true }]);
        expect(isWrongCode(error)).toBe(true);
        expect(error instanceof AppError && error.message).toBe('Invalid code');
        expect(toasts).toEqual([]);
    });

    test(`${name}: an expired sign-in is no wrong code, and a toast says it expired`, async () => {
        answer = {
            data: null,
            error: { status: 401, message: 'Invalid two factor cookie', code: 'INVALID_TWO_FACTOR_COOKIE' },
        };
        const error = await failure(use);
        expect(isWrongCode(error)).toBe(false);
        expect(isExpiredSignIn(error)).toBe(true);
        expect(toasts).toEqual(['Your sign-in expired. Sign in again.']);
    });

    test(`${name}: a locked account is a toast in better-auth's words`, async () => {
        answer = { data: null, error: { status: 429, message: 'Account temporarily locked' } };
        const error = await failure(use);
        expect(isWrongCode(error)).toBe(false);
        expect(error instanceof AppError && error.status).toBe(429);
        expect(toasts).toEqual(['Account temporarily locked']);
    });
}
