// Sign-in on the sign-in page: a member with a password through useAuth's login, or a guest who asks for a one-time
// code by email and sends it back, which sets the guest's session cookie through the public guest sign-in routes. A
// refusal of what was typed is the form's to show under its field, so these hooks raise no toast for one; any other
// failure, such as a rate limit or no connection, is a toast.

import { useMutation } from '@tanstack/react-query';
import { api } from '../../api';
import { AppError, onMutationError } from '../../api-error';
import { isRecord } from '../../guards';
import { useAuth } from '../auth-context';

// Wrong credentials and an unverified email. A rate limit, a server error or no connection is no reason to retype them.
export function isRefusedCredentials(error: unknown): boolean {
    return error instanceof AppError && (error.status === 400 || error.status === 401);
}

// An address that is no guest's or has nothing shared with it. A rate limit on asking is no reason to retype it.
export function isRefusedAddress(error: unknown): boolean {
    return error instanceof AppError && error.status === 400;
}

// A wrong or expired code, and too many wrong tries (429), which only a new code gets past.
export function isRefusedCode(error: unknown): boolean {
    return error instanceof AppError && (error.status === 400 || error.status === 429);
}

export function usePasswordSignIn() {
    const { login } = useAuth();
    return useMutation({
        mutationFn: async ({ email, password }: { email: string; password: string }) => {
            const { success, error } = await login(email, password);
            if (success) return;
            // better-auth answers a refusal with a plain object; better-fetch throws when there is no connection.
            if (!isRecord(error) || typeof error.status !== 'number') throw new Error('Login failed');
            throw new AppError({ status: error.status, error: { status: error.status, value: error } });
        },
        onError: (error) => {
            if (!isRefusedCredentials(error)) onMutationError(error);
        },
    });
}

export function useRequestGuestCode() {
    return useMutation({
        mutationFn: async (email: string) => {
            // No session yet, so the ask goes without the cookies the answer to a code sets.
            const res = await api['guest-auth']['request-otp'].post(
                { email },
                { fetch: { credentials: 'same-origin' } },
            );
            throwFailure(res, 'Failed to send code');
        },
        onError: (error) => {
            if (!isRefusedAddress(error)) onMutationError(error);
        },
    });
}

export function useVerifyGuestCode() {
    return useMutation({
        mutationFn: async ({ email, otp }: { email: string; otp: string }) => {
            throwFailure(await api['guest-auth']['verify-otp'].post({ email, otp }), 'Verification failed');
        },
        onError: (error) => {
            if (!isRefusedCode(error)) onMutationError(error);
        },
    });
}

// Eden answers a lost connection with no response at all, which `offline` names.
function throwFailure(
    res: { error: { status: unknown; value: unknown } | null; status: number; response?: Response },
    offline: string,
) {
    if (!res.error) return;
    throw res.response ? new AppError(res) : new Error(offline);
}
