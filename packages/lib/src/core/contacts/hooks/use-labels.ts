import {type QueryClient, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {contactsApi} from "@workspace/lib/api.ts";
import type {Label} from "@workspace/lib/types/label";
import {contactKeys} from './use-contacts';
import {useAuth} from '@workspace/lib/auth';

// Definieer query keys voor hergebruik
export const labelKeys = {
    all: ['labels'] as const,
    lists: () => [...labelKeys.all, 'list'] as const,
    list: (filters: string) => [...labelKeys.lists(), {filters}] as const,
    details: () => [...labelKeys.all, 'detail'] as const,
    detail: (id: string) => [...labelKeys.details(), id] as const,
};

// Hook to fetch all labels
export function useLabels() {
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: labelKeys.lists(),
        queryFn: async () => {
            const response = await contactsApi({ownerId}).labels.get();
            return response.data || [];
        },
        staleTime: 5 * 60 * 1000, // 5 minutes
        enabled: !!ownerId,
    });
}

// Hook to add a label
export function useAddLabel() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (labelData: Omit<Label, 'id'>) => {
            const response = await contactsApi({ownerId}).labels.post(labelData as any);
            return response.data;
        },
        onSuccess: () => invalidateLabelCreated(queryClient),
    });
}

// Hook to update a label
export function useUpdateLabel() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (updatedLabel: Label) => {
            const response = await contactsApi({ownerId}).labels({id: updatedLabel.id}).put({
                name: updatedLabel.name,
                color: updatedLabel.color
            } as any);
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateLabelUpdated(queryClient, variables.id),
    });
}

// Hook to delete a label
export function useDeleteLabel() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (labelId: string) => {
            const response = await contactsApi({ownerId}).labels({id: labelId}).delete();
            return response.data;
        },
        onSuccess: (_data, labelId) => invalidateLabelDeleted(queryClient, labelId),
    });
}

// SSE invalidation functions
export function invalidateLabelCreated(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: labelKeys.lists()});
}

export function invalidateLabelUpdated(queryClient: QueryClient, labelId: string): void {
    queryClient.invalidateQueries({queryKey: labelKeys.detail(labelId)});
    queryClient.invalidateQueries({queryKey: labelKeys.lists()});
    queryClient.invalidateQueries({queryKey: contactKeys.lists()});
}

export function invalidateLabelDeleted(queryClient: QueryClient, labelId: string): void {
    queryClient.removeQueries({queryKey: labelKeys.detail(labelId)});
    queryClient.invalidateQueries({queryKey: labelKeys.lists()});
    queryClient.invalidateQueries({queryKey: contactKeys.lists()});
}
