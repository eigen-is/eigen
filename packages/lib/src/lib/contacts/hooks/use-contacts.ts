import {useMutation, useQuery, useQueryClient, type QueryClient} from '@tanstack/react-query';
import {contactsApi} from '@workspace/lib/api.ts';
import {type Contact} from '@workspace/lib/types/contact';
import {invalidateHomeSize} from '../../home';

// Query keys for contacts
export const contactKeys = {
    all: ['contacts'] as const,
    lists: () => [...contactKeys.all, 'list'] as const,
    list: (filters: Record<string, unknown>) => [...contactKeys.lists(), {filters}] as const,
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
        },
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

// Fetch a contact by ID
export function useContact(id: string) {
    return useQuery({
        queryKey: contactKeys.detail(id),
        queryFn: async () => {
            if (!id) return null;
            const response = await contactsApi.contacts({id}).get();
            return response.data;
        },
        enabled: !!id,
    });
}

// Add a new contact
export function useAddContact() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (newContact: Omit<Contact, 'id'>) => {
            const response = await contactsApi.contacts.post(newContact);
            return response.data;
        },
        onSuccess: () => invalidateContactCreated(queryClient),
    });
}

// Update an existing contact
export function useUpdateContact() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({id, ...data}: Contact) => {
            const response = await contactsApi.contacts({id}).put(data);
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateContactUpdated(queryClient, variables.id),
    });
}

// Delete a contact
export function useDeleteContact() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const response = await contactsApi.contacts({id}).delete();
            return response.data;
        },
        onSuccess: (_data, id) => invalidateContactDeleted(queryClient, id),
    });
}

export async function getMeContact() {
    const {data} = await contactsApi.me.get();
    console.log(data);
    return data;
}

// SSE invalidation functions
export function invalidateContactCreated(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: contactKeys.lists()});
    invalidateHomeSize(queryClient);
}

export function invalidateContactUpdated(queryClient: QueryClient, contactId: string): void {
    queryClient.invalidateQueries({queryKey: contactKeys.detail(contactId)});
    queryClient.invalidateQueries({queryKey: contactKeys.lists()});
    invalidateHomeSize(queryClient);
}

export function invalidateContactDeleted(queryClient: QueryClient, contactId: string): void {
    queryClient.removeQueries({queryKey: contactKeys.detail(contactId)});
    queryClient.invalidateQueries({queryKey: contactKeys.lists()});
    invalidateHomeSize(queryClient);
}