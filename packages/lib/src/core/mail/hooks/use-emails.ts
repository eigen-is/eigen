import {type QueryClient, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {getMailComposeUrl, mailApi} from '@workspace/lib/api.ts';
import type {Email} from "@workspace/lib/types/mail";
import {useAuth} from '@workspace/lib/auth';
import {AppError, onMutationError} from '../../api-error';
import {invalidateMailboxes} from './use-mailboxes';

export const emailKeys = {
    all: ['emails'] as const,
    owner: (ownerId: string) => [...emailKeys.all, ownerId] as const,
    lists: (ownerId: string) => [...emailKeys.owner(ownerId), 'list'] as const,
    list: (ownerId: string, mailbox: string) => [...emailKeys.lists(ownerId), {mailbox: mailbox.toLowerCase()}] as const,
    details: (ownerId: string) => [...emailKeys.owner(ownerId), 'detail'] as const,
    detail: (ownerId: string, id: string) => [...emailKeys.details(ownerId), id] as const,
};

export function useEmails(mailboxPath: string) {
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: emailKeys.list(ownerId, mailboxPath),
        queryFn: async (): Promise<Email[]> => {
            const response = await mailApi({ownerId}).mailbox({mailboxPath: mailboxPath.toLowerCase()}).get();
            return (response.data || []) as Email[];
        },
        staleTime: 1 * 60 * 1000,
        enabled: !!ownerId,
    });
}

export function useEmail(messageId: string | undefined) {
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: emailKeys.detail(ownerId, messageId || ''),
        queryFn: async () => {
            if (!messageId) return null;
            const response = await mailApi({ownerId}).message({id: messageId}).get();
            return response.data || null;
        },
        enabled: !!messageId && !!ownerId,
        staleTime: Infinity,
    });
}

export function useEmailById() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return async (messageId: string): Promise<Email | null> => {
        if (!ownerId) return null;
        try {
            return await queryClient.fetchQuery({
                queryKey: emailKeys.detail(ownerId, messageId),
                queryFn: async () => {
                    const response = await mailApi({ownerId}).message({id: messageId}).get();
                    return response.data || null;
                },
                staleTime: Infinity,
            });
        } catch {
            return null;
        }
    };
}

export function useDeleteEmail() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (email: Email) => {
            if (email.mailbox === 'Trash') {
                const response = await mailApi({ownerId}).message({id: email.id}).delete();
                if (response.error) throw new AppError(response);
            } else {
                const response = await mailApi({ownerId}).message["move-to-trash"].put({messageId: email.id});
                if (response.error) throw new AppError(response);
            }
            return email;
        },
        onSuccess: (email) => {
            if (email.mailbox === 'Trash') {
                invalidateMailDeleted(queryClient, ownerId, email.id, 'Trash');
            } else {
                invalidateMailMoved(queryClient, ownerId, email.id, email.mailbox, 'Trash');
            }
            invalidateMailboxes(queryClient, ownerId);
        },
        onError: onMutationError,
    });
}

export function useToggleReadEmail() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async ({email, isRead}: { email: Email, isRead: boolean }) => {
            if (isRead === email.isRead) {
                return email;
            }
            const response = await mailApi({ownerId}).message({id: email.id}).read.put({
                read: isRead
            });
            if (response.error) throw new AppError(response);
            return email;
        },
        onSuccess: (email) => {
            invalidateMailReadChanged(queryClient, ownerId, email.id, email.mailbox);
            invalidateMailboxes(queryClient, ownerId);
        },
        onError: onMutationError,
    });
}

export function useToggleFlaggedEmail() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async ({email, isFlagged}: { email: Email, isFlagged: boolean }) => {
            if (isFlagged === email.isFlagged) {
                return email;
            }
            const response = await mailApi({ownerId}).message({id: email.id}).flagged.put({
                flagged: isFlagged
            });
            if (response.error) throw new AppError(response);
            return email;
        },
        onSuccess: (email) => invalidateMailFlagsChanged(queryClient, ownerId, email.id, email.mailbox),
        onError: onMutationError,
    });
}

export function useMoveEmail() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async ({email, mailbox}: { email: Email, mailbox: string }) => {
            const response = await mailApi({ownerId}).message.move.put({
                messageId: email.id,
                targetMailbox: mailbox
            });
            if (response.error) throw new AppError(response);
            return email;
        },
        onSuccess: (email, variables) => {
            invalidateMailMoved(queryClient, ownerId, email.id, email.mailbox, variables.mailbox);
            invalidateMailboxes(queryClient, ownerId);
        },
        onError: onMutationError,
    });
}

export function useOpenWriteEmailTo() {
    return (address: string) => {
        window.location.href = getMailComposeUrl(address)
    }
}

// Invalidation functions (ownerId-scoped, used from mutation onSuccess)
export function invalidateMailReceived(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({queryKey: emailKeys.list(ownerId, 'inbox')});
}

export function invalidateMailDeleted(queryClient: QueryClient, ownerId: string, messageId: string, mailbox: string): void {
    queryClient.removeQueries({queryKey: emailKeys.detail(ownerId, messageId)});
    queryClient.invalidateQueries({queryKey: emailKeys.list(ownerId, mailbox)});
}

export function invalidateMailMoved(queryClient: QueryClient, ownerId: string, messageId: string, fromMailbox: string, toMailbox: string | null | undefined): void {
    queryClient.invalidateQueries({queryKey: emailKeys.detail(ownerId, messageId)});
    queryClient.invalidateQueries({queryKey: emailKeys.list(ownerId, fromMailbox)});
    if (toMailbox) {
        queryClient.invalidateQueries({queryKey: emailKeys.list(ownerId, toMailbox)});
    }
}

export function invalidateMailReadChanged(queryClient: QueryClient, ownerId: string, messageId: string, mailbox: string): void {
    queryClient.invalidateQueries({queryKey: emailKeys.detail(ownerId, messageId)});
    queryClient.invalidateQueries({queryKey: emailKeys.list(ownerId, mailbox)});
}

export function invalidateMailFlagsChanged(queryClient: QueryClient, ownerId: string, messageId: string, mailbox: string): void {
    queryClient.invalidateQueries({queryKey: emailKeys.detail(ownerId, messageId)});
    queryClient.invalidateQueries({queryKey: emailKeys.list(ownerId, mailbox)});
}

export function invalidateDraftUpdated(queryClient: QueryClient, ownerId: string, messageId: string): void {
    queryClient.invalidateQueries({queryKey: emailKeys.list(ownerId, 'Drafts')});
    queryClient.invalidateQueries({queryKey: emailKeys.detail(ownerId, messageId)});
}
