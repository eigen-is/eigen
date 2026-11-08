// The contact hooks: the list, the user's own card, and adding, updating, deleting and the avatar upload. A write that
// meets a 412 because the card changed elsewhere reloads the list and says so in its own toast. The Contacts app calls
// them, and so do other readers of the address book, such as the contact suggestions and the profile editor.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { contactsApi, getContactsAvatarUploadUrl } from '@workspace/lib/api';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { CreateContactInput, UpdateContactInput } from '@workspace/lib/types/contact';
import { AppError, onEtagWriteError, onMutationError } from '../../api-error';
import { contactKeys, invalidateContactList } from './keys';

// A write echoes the etag its form holds, and a 412 means the card changed elsewhere first. The hook reloads the list
// and tells the user. It says nothing about what was typed, because the profile form re-seeds on a reload.
const STALE_WRITE_TOAST = 'This contact changed elsewhere. Check it and try again.';

export function useContacts() {
    const { user } = useAuth();
    const isGuest = useIsGuest();
    const ownerId = user?.id ?? '';

    return useQuery({
        queryKey: contactKeys.lists(ownerId),
        queryFn: async () => {
            const response = await contactsApi({ ownerId }).contacts.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: STALE_TIME.FIVE_MINUTES,
        enabled: !!ownerId && !isGuest,
    });
}

export function useAddContact() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id ?? '';

    return useMutation({
        mutationFn: async (newContact: CreateContactInput) => {
            const response = await contactsApi({ ownerId }).contacts.post(newContact);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateContactList(queryClient, ownerId),
        onError: onMutationError,
    });
}

export function useUpdateContact() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id ?? '';

    return useMutation({
        mutationFn: async ({ id, ...data }: UpdateContactInput & { id: string }) => {
            const response = await contactsApi({ ownerId }).contacts({ id }).put(data);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateContactList(queryClient, ownerId),
        onError: (error) =>
            onEtagWriteError(error, STALE_WRITE_TOAST, () => invalidateContactList(queryClient, ownerId)),
    });
}

export function useDeleteContact() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id ?? '';

    return useMutation({
        mutationFn: async ({ id, etag }: { id: string; etag: string }) => {
            const response = await contactsApi({ ownerId }).contacts({ id }).delete({}, { query: { etag } });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateContactList(queryClient, ownerId),
        onError: (error) =>
            onEtagWriteError(error, STALE_WRITE_TOAST, () => invalidateContactList(queryClient, ownerId)),
    });
}

export function useMeContact() {
    const { user } = useAuth();
    const isGuest = useIsGuest();
    const ownerId = user?.id ?? '';

    return useQuery({
        queryKey: contactKeys.me(ownerId),
        queryFn: async () => {
            const response = await contactsApi({ ownerId }).me.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId && !isGuest,
        staleTime: STALE_TIME.FIVE_MINUTES,
    });
}

// Eden Treaty serializes bodies as JSON, so this multipart upload is a raw fetch. It returns the stored avatar path.
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
    const ownerId = user?.id ?? '';

    return useMutation({
        mutationFn: (file: File) => uploadContactAvatarRequest(ownerId, file),
        onError: onMutationError,
    });
}
