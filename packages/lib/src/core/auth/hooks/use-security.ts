// The user's own security settings, through better-auth's client: changing the password, and turning two-factor
// authentication on, checking its codes and turning it off. Space's security pages and its two-factor sign-in step
// call them. A refusal carries better-auth's status and words, and a wrong code is left to the form to show under
// its field, so its hooks raise no toast for one.

import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AppError, authFailure, onMutationError } from '../../api-error';
import { authClient } from './use-auth-client';

// better-auth refuses a code that isn't the current one, or a backup code already used, with a 401.
export function isWrongCode(error: unknown): boolean {
    return error instanceof AppError && error.status === 401;
}

function onCodeError(error: unknown): void {
    if (!isWrongCode(error)) onMutationError(error);
}

export function useChangePassword() {
    return useMutation({
        mutationFn: async (data: { currentPassword: string; newPassword: string; revokeOtherSessions: boolean }) => {
            const result = await authClient.changePassword(data);
            if (result.error) throw authFailure(result.error, 'Failed to change password');
            return result.data;
        },
        onSuccess: () => {
            toast.success('Password changed successfully');
        },
        onError: onMutationError,
    });
}

export function useInitialize2FA() {
    return useMutation({
        mutationFn: async (password: string) => {
            const result = await authClient.twoFactor.enable({ password, method: 'totp' });
            if (result.error) throw authFailure(result.error, 'Failed to initialize two-factor authentication');
            if (result.data.method !== 'totp') throw new Error('Unexpected two-factor method');
            return result.data;
        },
        onError: onMutationError,
    });
}

export function useVerifyTotp() {
    return useMutation({
        mutationFn: async (input: { code: string; trustDevice?: boolean }) => {
            const result = await authClient.twoFactor.verifyTotp(input);
            if (result.error) throw authFailure(result.error, 'Failed to verify verification code');
            return result.data;
        },
        onError: onCodeError,
    });
}

export function useVerifyBackupCode() {
    return useMutation({
        mutationFn: async (input: { code: string; trustDevice?: boolean }) => {
            const result = await authClient.twoFactor.verifyBackupCode(input);
            if (result.error) throw authFailure(result.error, 'Invalid backup code');
            return result.data;
        },
        onError: onCodeError,
    });
}

export function useDisable2FA() {
    return useMutation({
        mutationFn: async (password: string) => {
            const result = await authClient.twoFactor.disable({ password });
            if (result.error) throw authFailure(result.error, 'Failed to disable two-factor authentication');
            return result.data;
        },
        onSuccess: () => {
            toast.success('Two-factor authentication disabled');
        },
        onError: onMutationError,
    });
}
