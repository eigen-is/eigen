import { 
  useQuery, 
  useMutation, 
  QueryClient 
} from '@tanstack/react-query';
import { contactsApi } from '../../../../packages/lib/src/lib/api';
import { type Contact } from '@apps/api-server/types/contact';

// Query keys for contacts
export const contactKeys = {
  all: ['contacts'] as const,
  lists: () => [...contactKeys.all, 'list'] as const,
  list: (filters: Record<string, unknown>) => [...contactKeys.lists(), { filters }] as const,
  details: () => [...contactKeys.all, 'detail'] as const,
  detail: (id: string) => [...contactKeys.details(), id] as const,
};

// Fetch all contacts
export function useContacts() {
  return useQuery({
    queryKey: contactKeys.lists(),
    queryFn: async () => {
      const response = await contactsApi.contacts.get();
      return response.data || [];
    }
  });
}

// Fetch a contact by ID
export function useContact(id: string) {
  return useQuery({
    queryKey: contactKeys.detail(id),
    queryFn: async () => {
      if (!id) return null;
      const response = await contactsApi.contacts[id].get();
      return response.data;
    },
    enabled: !!id,
  });
}

// Add a new contact
export function useAddContact() {
  const queryClient = new QueryClient();
  
  return useMutation({
    mutationFn: async (newContact: Omit<Contact, 'id'>) => {
      const response = await contactsApi.contacts.post(newContact as any);
      return response.data;
    },
    onSuccess: () => {
      // Invalidate and refetch contacts list
      queryClient.invalidateQueries({ queryKey: contactKeys.lists() });
    },
  });
}

// Update an existing contact
export function useUpdateContact() {
  const queryClient = new QueryClient();
  
  return useMutation({
    mutationFn: async ({ id, ...data }: Contact) => {
      const response = await contactsApi.contacts[id].put(data as any);
      return response.data;
    },
    onSuccess: (_, variables) => {
      // Invalidate and refetch the specific contact and the contact list
      queryClient.invalidateQueries({ queryKey: contactKeys.detail(variables.id) });
      queryClient.invalidateQueries({ queryKey: contactKeys.lists() });
    },
  });
}

// Delete a contact
export function useDeleteContact() {
  const queryClient = new QueryClient();
  
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await contactsApi.contacts[id].delete();
      return response.data;
    },
    onSuccess: () => {
      // Invalidate and refetch the contacts list
      queryClient.invalidateQueries({ queryKey: contactKeys.lists() });
    },
  });
}
