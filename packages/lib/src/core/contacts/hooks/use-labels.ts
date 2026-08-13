import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { contactsApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { Label } from '@workspace/lib/types/label';
import { AppError, onMutationError } from '../../api-error';
import { invalidateLabelCreated, invalidateLabelDeleted, invalidateLabelUpdated, labelKeys } from './keys';

// Hook to fetch all labels
export function useLabels() {
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: labelKeys.lists(ownerId),
        queryFn: async () => {
            const response = await contactsApi({ ownerId }).labels.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: STALE_TIME.FIVE_MINUTES,
        enabled: !!ownerId,
    });
}

// Hook to add a label
export function useAddLabel() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (labelData: Omit<Label, 'id'>) => {
            const response = await contactsApi({ ownerId }).labels.post(labelData);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateLabelCreated(queryClient, ownerId),
        onError: onMutationError,
    });
}

// Hook to update a label
export function useUpdateLabel() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (updatedLabel: Label) => {
            const response = await contactsApi({ ownerId }).labels({ id: updatedLabel.id }).put({
                name: updatedLabel.name,
                color: updatedLabel.color,
            });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateLabelUpdated(queryClient, ownerId, variables.id),
        onError: onMutationError,
    });
}

// Hook to delete a label
export function useDeleteLabel() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (labelId: string) => {
            const response = await contactsApi({ ownerId }).labels({ id: labelId }).delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, labelId) => invalidateLabelDeleted(queryClient, ownerId, labelId),
        onError: onMutationError,
    });
}
