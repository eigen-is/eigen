import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {contactsApi} from "@workspace/lib/api.ts";
import type {Label} from "@apps/api-server/types/label";

// Definieer query keys voor hergebruik
export const labelKeys = {
  all: ['labels'] as const,
  lists: () => [...labelKeys.all, 'list'] as const,
  list: (filters: string) => [...labelKeys.lists(), { filters }] as const,
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
  });
}

// Hook om een label toe te voegen
export function useAddLabel() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (labelData: Omit<Label, 'id'>) => {
      // We gebruiken type assertion om TypeScript te laten weten dat dit oké is
      const response = await contactsApi.labels.post(labelData as any);
      return response.data;
    },
    onSuccess: () => {
      // Invalideer de label-lijst zodat deze opnieuw wordt opgehaald
      queryClient.invalidateQueries({ queryKey: labelKeys.lists() });
    },
  });
}

// Hook om een label te bewerken
export function useUpdateLabel() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (updatedLabel: Label) => {
      // We gebruiken type assertion om TypeScript te laten weten dat dit oké is
      const response = await contactsApi.labels[updatedLabel.id].put({
        name: updatedLabel.name, 
        color: updatedLabel.color
      } as any);
      return response.data;
    },
    onSuccess: (_, variables) => {
      // Invalideer zowel de specifieke label als de volledige lijst
      queryClient.invalidateQueries({ 
        queryKey: labelKeys.detail(variables.id) 
      });
      queryClient.invalidateQueries({ 
        queryKey: labelKeys.lists() 
      });
    },
  });
}

// Hook om een label te verwijderen
export function useDeleteLabel() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (labelId: string) => {
      const response = await contactsApi.labels[labelId].delete();
      return response.data;
    },
    onSuccess: (_, labelId) => {
      // Invalideer de label-lijst zodat deze opnieuw wordt opgehaald
      queryClient.invalidateQueries({ 
        queryKey: labelKeys.lists() 
      });
      // Verwijder de cache voor deze specifieke label
      queryClient.removeQueries({ 
        queryKey: labelKeys.detail(labelId) 
      });
    },
  });
}
