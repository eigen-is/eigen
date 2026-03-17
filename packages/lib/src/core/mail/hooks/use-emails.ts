import {type QueryClient, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {getMailComposeUrl, mailApi} from '@workspace/lib/api.ts';
import type {Email} from "@workspace/lib/types/mail";
import {useAuth} from '@workspace/lib/auth';

export const emailKeys = {
    all: ['emails'] as const,
    lists: () => [...emailKeys.all, 'list'] as const,
    list: (mailbox: string) => [...emailKeys.lists(), {mailbox}] as const,
    details: () => [...emailKeys.all, 'detail'] as const,
    detail: (id: string) => [...emailKeys.details(), id] as const,
};

export function useEmails(mailboxPath: string) {
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: emailKeys.list(mailboxPath),
        queryFn: async () => {
            let path = mailboxPath.toLowerCase();
            path = path === 'inbox' ? '' : path;
            const response = await (mailApi({ownerId}).mailbox as any)[path].get();
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
        queryKey: emailKeys.detail(messageId || ''),
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
                queryKey: emailKeys.detail(messageId),
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
                await mailApi({ownerId}).message({id: email.id}).delete();
            } else {
                await mailApi({ownerId}).message["move-to-trash"].put({messageId: email.id});
            }
            return email;
        },
        onSuccess: (email) => {
            if (email.mailbox === 'Trash') {
                invalidateMailDeleted(queryClient, email.id, 'Trash');
            } else {
                invalidateMailMoved(queryClient, email.id, email.mailbox, 'Trash');
            }
        },
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
            await mailApi({ownerId}).message({id: email.id}).read.put({
                read: isRead
            });
            return email;
        },
        onSuccess: (email) => invalidateMailReadChanged(queryClient, email.id, email.mailbox),
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
            await mailApi({ownerId}).message({id: email.id}).flagged.put({
                flagged: isFlagged
            });
            return email;
        },
        onSuccess: (email) => invalidateMailFlagsChanged(queryClient, email.id, email.mailbox),
    });
}

export function useMoveEmail() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async ({email, mailbox}: { email: Email, mailbox: string }) => {
            await mailApi({ownerId}).message.move.put({
                messageId: email.id,
                targetMailbox: mailbox
            });
            return email;
        },
        onSuccess: (email, variables) => invalidateMailMoved(queryClient, email.id, email.mailbox, variables.mailbox),
    });
}

export function useOpenWriteEmailTo() {
    return (address: string) => {
        window.location.href = getMailComposeUrl(address)
    }
}

// SSE invalidation functions
export function invalidateMailReceived(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: emailKeys.list('inbox')});
}

export function invalidateMailDeleted(queryClient: QueryClient, messageId: string, mailbox: string): void {
    queryClient.removeQueries({queryKey: emailKeys.detail(messageId)});
    queryClient.invalidateQueries({queryKey: emailKeys.list(mailbox)});
}

export function invalidateMailMoved(queryClient: QueryClient, messageId: string, fromMailbox: string, toMailbox: string | null | undefined): void {
    queryClient.invalidateQueries({queryKey: emailKeys.detail(messageId)});
    queryClient.invalidateQueries({queryKey: emailKeys.list(fromMailbox)});
    if (toMailbox) {
        queryClient.invalidateQueries({queryKey: emailKeys.list(toMailbox)});
    }
}

export function invalidateMailReadChanged(queryClient: QueryClient, messageId: string, mailbox: string): void {
    queryClient.invalidateQueries({queryKey: emailKeys.detail(messageId)});
    queryClient.invalidateQueries({queryKey: emailKeys.list(mailbox)});
}

export function invalidateMailFlagsChanged(queryClient: QueryClient, messageId: string, mailbox: string): void {
    queryClient.invalidateQueries({queryKey: emailKeys.detail(messageId)});
    queryClient.invalidateQueries({queryKey: emailKeys.list(mailbox)});
}

export function invalidateDraftUpdated(queryClient: QueryClient, messageId: string): void {
    queryClient.invalidateQueries({queryKey: emailKeys.list('Drafts')});
    queryClient.invalidateQueries({queryKey: emailKeys.detail(messageId)});
}
