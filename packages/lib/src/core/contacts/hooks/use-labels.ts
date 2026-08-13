import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { contactsApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { Label } from '@workspace/lib/types/label';
import { AppError, onMutationError } from '../../api-error';
import { contactKeys } from './use-contacts';

// Define query keys for reuse
export const labelKeys = {
    all: ['labels'] as const,
    owner: (ownerId: string) => [...labelKeys.all, ownerId] as const,
    lists: (ownerId: string) => [...labelKeys.owner(ownerId), 'list'] as const,
    list: (ownerId: string, filters: string) => [...labelKeys.lists(ownerId), { filters }] as const,
    details: (ownerId: string) => [...labelKeys.owner(ownerId), 'detail'] as const,
    detail: (ownerId: string, id: string) => [...labelKeys.details(ownerId), id] as const,
};

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

// Invalidation functions (ownerId-scoped, used from mutation onSuccess)
export function invalidateLabelCreated(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: labelKeys.lists(ownerId) });
}

export function invalidateLabelUpdated(queryClient: QueryClient, ownerId: string, labelId: string): void {
    queryClient.invalidateQueries({ queryKey: labelKeys.detail(ownerId, labelId) });
    queryClient.invalidateQueries({ queryKey: labelKeys.lists(ownerId) });
    queryClient.invalidateQueries({ queryKey: contactKeys.lists(ownerId) });
}

export function invalidateLabelDeleted(queryClient: QueryClient, ownerId: string, labelId: string): void {
    queryClient.removeQueries({ queryKey: labelKeys.detail(ownerId, labelId) });
    queryClient.invalidateQueries({ queryKey: labelKeys.lists(ownerId) });
    queryClient.invalidateQueries({ queryKey: contactKeys.lists(ownerId) });
}
