import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { onMutationError } from '../../api-error';
import { authClient } from './use-auth-client';

export function useChangePassword() {
    return useMutation({
        mutationFn: async (data: { currentPassword: string; newPassword: string; revokeOtherSessions: boolean }) => {
            const result = await authClient.changePassword(data);
            if (result.error) throw new Error(result.error.message ?? 'Failed to change password');
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
            const result = await authClient.twoFactor.enable({ password });
            if (result.error) throw new Error(result.error.message ?? 'Failed to initialize two-factor authentication');
            return result.data;
        },
        onError: onMutationError,
    });
}

export function useVerifyTotp() {
    return useMutation({
        mutationFn: async (input: { code: string; trustDevice?: boolean }) => {
            const result = await authClient.twoFactor.verifyTotp(input);
            if (result.error) throw new Error(result.error.message ?? 'Failed to verify verification code');
            return result.data;
        },
        onError: onMutationError,
    });
}

export function useVerifyBackupCode() {
    return useMutation({
        mutationFn: async (input: { code: string; trustDevice?: boolean }) => {
            const result = await authClient.twoFactor.verifyBackupCode(input);
            if (result.error) throw new Error(result.error.message ?? 'Invalid backup code');
            return result.data;
        },
        onError: onMutationError,
    });
}

export function useDisable2FA() {
    return useMutation({
        mutationFn: async (password: string) => {
            const result = await authClient.twoFactor.disable({ password });
            if (result.error) throw new Error(result.error.message ?? 'Failed to disable two-factor authentication');
            return result.data;
        },
        onSuccess: () => {
            toast.success('Two-factor authentication disabled');
        },
        onError: onMutationError,
    });
}
