// The contact hooks: the list, the user's own card, and adding, updating, deleting and the avatar upload. A write that
// meets a 412 because the card changed elsewhere reloads the list and says so in its own toast. The Contacts app calls
// them, and so do other readers of the address book, such as the contact suggestions and the profile editor.

import type { QueryClient } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { contactsApi, getContactsAvatarUploadUrl } from '@workspace/lib/api';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { CreateContactInput, UpdateContactInput } from '@workspace/lib/types/contact';
import { toast } from 'sonner';
import { AppError, markToasted, onMutationError } from '../../api-error';
import { contactKeys, invalidateContactList } from './keys';

// A write echoes the etag its form loaded, and a 412 means the card changed elsewhere first. The hook reloads the list
// so the form shows the current card, and tells the user.
const STALE_WRITE_TOAST = 'This contact changed elsewhere. It has been reloaded — please redo your edit.';

// The edit form re-seeds after one, since the toast tells the user the card was reloaded.
export function isStaleWrite(error: unknown): boolean {
    return error instanceof AppError && error.status === 412;
}

// The update and the delete recover a 412 the same way. It returns true when it handled one, so the caller skips
// onMutationError. The error counts as toasted, so a dialog that awaits the write doesn't log it again.
function handleStaleWrite(queryClient: QueryClient, ownerId: string, error: unknown): boolean {
    if (!isStaleWrite(error)) return false;
    invalidateContactList(queryClient, ownerId);
    markToasted(error);
    toast.error(STALE_WRITE_TOAST);
    return true;
}

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
        onError: (error) => {
            if (handleStaleWrite(queryClient, ownerId, error)) return;
            onMutationError(error);
        },
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
        onError: (error) => {
            if (handleStaleWrite(queryClient, ownerId, error)) return;
            onMutationError(error);
        },
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
    const ownerId = user?.id ?? '';

    return useMutation({
        mutationFn: (file: File) => uploadContactAvatarRequest(ownerId, file),
        onError: onMutationError,
    });
}
