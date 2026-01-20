import {useMutation, useQuery} from '@tanstack/react-query';
import {contactsApi} from "@workspace/lib/api.ts";
import type {Label} from "@workspace/lib/types/label";

// Definieer query keys voor hergebruik
export const labelKeys = {
    all: ['labels'] as const,
    lists: () => [...labelKeys.all, 'list'] as const,
    list: (filters: string) => [...labelKeys.lists(), {filters}] as const,
    details: () => [...labelKeys.all, 'detail'] as const,
    detail: (id: string) => [...labelKeys.details(), id] as const,
};

// Hook om alle labels op te halen
export function useLabels() {
    return useQuery({
        queryKey: labelKeys.lists(),
        queryFn: async () => {
            const response = await contactsApi.labels.get();
            return response.data || [];
        },
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

// Hook om een label toe te voegen
export function useAddLabel() {
    return useMutation({
        mutationFn: async (labelData: Omit<Label, 'id'>) => {
            const response = await contactsApi.labels.post(labelData as any);
            return response.data;
        },
    });
}

// Hook om een label te bewerken
export function useUpdateLabel() {
    return useMutation({
        mutationFn: async (updatedLabel: Label) => {
            const response = await contactsApi.labels({id: updatedLabel.id}).put({
                name: updatedLabel.name,
                color: updatedLabel.color
            } as any);
            return response.data;
        },
    });
}

// Hook om een label te verwijderen
export function useDeleteLabel() {
    return useMutation({
        mutationFn: async (labelId: string) => {
            const response = await contactsApi.labels({id: labelId}).delete();
            return response.data;
        },
    });
}
