import {type QueryClient, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {contactsApi} from '@workspace/lib/api.ts';
import {type Contact} from '@workspace/lib/types/contact';
import {invalidateHomeSize} from '../../home';
import {useAuth} from '@workspace/lib/auth';
import {AppError, onMutationError} from '../../api-error';

// Query keys for contacts
export const contactKeys = {
    all: ['contacts'] as const,
    lists: () => [...contactKeys.all, 'list'] as const,
    list: (filters: Record<string, unknown>) => [...contactKeys.lists(), {filters}] as const,
    details: () => [...contactKeys.all, 'detail'] as const,
    detail: (id: string) => [...contactKeys.details(), id] as const,
    me: () => [...contactKeys.all, 'me'] as const,
};

// Fetch all contacts
export function useContacts() {
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: contactKeys.lists(),
        queryFn: async () => {
            const response = await contactsApi({ownerId}).contacts.get();
            return response.data || [];
        },
        staleTime: 5 * 60 * 1000, // 5 minutes
        enabled: !!ownerId,
    });
}

// Fetch a contact by ID
export function useContact(id: string) {
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: contactKeys.detail(id),
        queryFn: async () => {
            if (!id) return null;
            const response = await contactsApi({ownerId}).contacts({id}).get();
            return response.data;
        },
        enabled: !!id && !!ownerId,
    });
}

// Add a new contact
export function useAddContact() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (newContact: Omit<Contact, 'id'>) => {
            const response = await contactsApi({ownerId}).contacts.post(newContact);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateContactCreated(queryClient),
        onError: onMutationError,
    });
}

// Update an existing contact
export function useUpdateContact() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async ({id, ...data}: Contact) => {
            const response = await contactsApi({ownerId}).contacts({id}).put(data);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateContactUpdated(queryClient, variables.id),
        onError: onMutationError,
    });
}

// Delete a contact
export function useDeleteContact() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (id: string) => {
            const response = await contactsApi({ownerId}).contacts({id}).delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, id) => invalidateContactDeleted(queryClient, id),
        onError: onMutationError,
    });
}

export function useMeContact() {
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: contactKeys.me(),
        queryFn: async () => {
            const response = await contactsApi({ownerId}).me.get();
            return response.data ?? null;
        },
        enabled: !!ownerId,
    });
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