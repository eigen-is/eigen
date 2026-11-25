// A guest's sign-in on the sign-in page: ask for a one-time code by email, then send the code back, which sets the
// guest's session cookie. Both post to the public guest sign-in routes before anyone is signed in. A refusal of what
// was typed is the form's to show under its field, so these hooks raise no toast for one; any other failure, no
// connection included, is a toast.

import { useMutation } from '@tanstack/react-query';
import { API_HOST } from '../../api';
import { AppError, appErrorFrom, onMutationError } from '../../api-error';

// An address that is no guest's or has nothing shared with it. A rate limit on asking is no reason to retype it.
export function isRefusedAddress(error: unknown): boolean {
    return error instanceof AppError && error.status === 400;
}

// A wrong or expired code, and too many wrong tries (429), which only a new code gets past.
export function isRefusedCode(error: unknown): boolean {
    return error instanceof AppError && (error.status === 400 || error.status === 429);
}

export function useRequestGuestCode() {
    return useMutation({
        mutationFn: (email: string) => postGuestAuth('request-otp', { email }, 'Failed to send code'),
        onError: (error) => {
            if (!isRefusedAddress(error)) onMutationError(error);
        },
    });
}

export function useVerifyGuestCode() {
    return useMutation({
        mutationFn: ({ email, otp }: { email: string; otp: string }) =>
            postGuestAuth('verify-otp', { email, otp }, 'Verification failed', 'include'),
        onError: (error) => {
            if (!isRefusedCode(error)) onMutationError(error);
        },
    });
}

// Throws the server's refusal, or `offline` when no answer came. `credentials` lets the answer set the session cookie.
async function postGuestAuth(
    route: string,
    body: object,
    offline: string,
    credentials?: RequestCredentials,
): Promise<void> {
    const res = await fetch(`${API_HOST}/guest-auth/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials,
        body: JSON.stringify(body),
    }).catch(() => {
        throw new Error(offline);
    });
    if (!res.ok) throw await appErrorFrom(res);
}
