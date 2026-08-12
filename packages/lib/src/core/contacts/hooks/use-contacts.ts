import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { contactsApi, getContactsAvatarUploadUrl } from '@workspace/lib/api';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import type { Contact } from '@workspace/lib/types/contact';
import { AppError, onMutationError } from '../../api-error';
import { invalidateHomeSize } from '../../home';

// Query keys for contacts
export const contactKeys = {
    all: ['contacts'] as const,
    owner: (ownerId: string) => [...contactKeys.all, ownerId] as const,
    lists: (ownerId: string) => [...contactKeys.owner(ownerId), 'list'] as const,
    list: (ownerId: string, filters: Record<string, unknown>) => [...contactKeys.lists(ownerId), { filters }] as const,
    details: (ownerId: string) => [...contactKeys.owner(ownerId), 'detail'] as const,
    detail: (ownerId: string, id: string) => [...contactKeys.details(ownerId), id] as const,
    me: (ownerId: string) => [...contactKeys.owner(ownerId), 'me'] as const,
};

// Fetch all contacts
export function useContacts() {
    const { user } = useAuth();
    const isGuest = useIsGuest();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: contactKeys.lists(ownerId),
        queryFn: async () => {
            const response = await contactsApi({ ownerId }).contacts.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: 5 * 60 * 1000, // 5 minutes
        enabled: !!ownerId && !isGuest,
    });
}

// Fetch a contact by ID
export function useContact(id: string) {
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: contactKeys.detail(ownerId, id),
        queryFn: async () => {
            if (!id) return null;
            const response = await contactsApi({ ownerId }).contacts({ id }).get();
            return response.data;
        },
        enabled: !!id && !!ownerId,
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

// Add a new contact
export function useAddContact() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (newContact: Omit<Contact, 'id'>) => {
            const response = await contactsApi({ ownerId }).contacts.post(newContact);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateContactCreated(queryClient, ownerId),
        onError: onMutationError,
    });
}

// Update an existing contact
export function useUpdateContact() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async ({ id, ...data }: Contact) => {
            const response = await contactsApi({ ownerId }).contacts({ id }).put(data);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateContactUpdated(queryClient, ownerId, variables.id),
        onError: onMutationError,
    });
}

// Delete a contact
export function useDeleteContact() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (id: string) => {
            const response = await contactsApi({ ownerId }).contacts({ id }).delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, id) => invalidateContactDeleted(queryClient, ownerId, id),
        onError: onMutationError,
    });
}

export function useMeContact() {
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: contactKeys.me(ownerId),
        queryFn: async () => {
            const response = await contactsApi({ ownerId }).me.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId,
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

// Multipart avatar upload bypasses Eden Treaty (which serializes bodies as JSON) and goes through
// raw fetch, mirroring useUploadDraftAttachment. Returns the stored avatar path.
async function uploadContactAvatarRequest(ownerId: string, file: File): Promise<string> {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(getContactsAvatarUploadUrl(ownerId), {
        method: 'POST',
        body: formData,
        credentials: 'include',
    });
    if (!res.ok) throw new AppError({ status: res.status, error: { status: res.status, value: await res.text() } });
    return await res.text();
}

export function useUploadContactAvatar() {
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: (file: File) => uploadContactAvatarRequest(ownerId, file),
        onError: onMutationError,
    });
}

// Invalidation functions (ownerId-scoped, used from mutation onSuccess)
export function invalidateContactCreated(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: contactKeys.lists(ownerId) });
    invalidateHomeSize(queryClient, ownerId);
}

export function invalidateContactUpdated(queryClient: QueryClient, ownerId: string, contactId: string): void {
    queryClient.invalidateQueries({ queryKey: contactKeys.detail(ownerId, contactId) });
    queryClient.invalidateQueries({ queryKey: contactKeys.lists(ownerId) });
    invalidateHomeSize(queryClient, ownerId);
}

export function invalidateContactDeleted(queryClient: QueryClient, ownerId: string, contactId: string): void {
    queryClient.removeQueries({ queryKey: contactKeys.detail(ownerId, contactId) });
    queryClient.invalidateQueries({ queryKey: contactKeys.lists(ownerId) });
    invalidateHomeSize(queryClient, ownerId);
}
