import {useMutation, useQuery, useQueryClient, type QueryClient} from '@tanstack/react-query';
import {mailApi} from '@workspace/lib/api.ts';
import {Email} from "@workspace/lib/types/mail";

// Define query keys for reuse
export const emailKeys = {
    all: ['emails'] as const,
    lists: () => [...emailKeys.all, 'list'] as const,
    list: (mailbox: string) => [...emailKeys.lists(), {mailbox}] as const,
    details: () => [...emailKeys.all, 'detail'] as const,
    detail: (id: string) => [...emailKeys.details(), id] as const,
};

// Hook to fetch emails for a specific mailbox
export function useEmails(mailboxPath: string) {
    return useQuery({
        queryKey: emailKeys.list(mailboxPath),
        queryFn: async () => {
            mailboxPath = mailboxPath.toLowerCase();
            mailboxPath = mailboxPath === 'inbox' ? '' : mailboxPath;
            // Wildcard route - use type assertion for dynamic path
            const response = await (mailApi.mailbox as any)[mailboxPath].get();
            return (response.data || []) as Email[];
        },
        staleTime: 1 * 60 * 1000, // 1 minute
    });
}

// Hook to fetch a specific email by ID
export function useEmail(messageId: string | undefined) {
    return useQuery({
        queryKey: emailKeys.detail(messageId || ''),
        queryFn: async () => {
            if (!messageId) return null;
            const response = await mailApi.message({id: messageId}).get();
            return response.data || null;
        },
        enabled: !!messageId,
        staleTime: Infinity,
    });
}

// Hook to fetch a specific email by ID
export function useEmailById() {
    const queryClient = useQueryClient();

    // Return a function that uses queryClient.fetchQuery
    return async (messageId: string): Promise<Email | null> => {
        try {
            return await queryClient.fetchQuery({
                queryKey: emailKeys.detail(messageId),
                queryFn: async () => {
                    const response = await mailApi.message({id: messageId}).get();
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
    return useMutation({
        mutationFn: async (email: Email) => {
            if (email.mailbox === 'trash') {
                await mailApi.message({id: email.id}).delete();
            } else {
                await mailApi.message.moveToTrash.put({messageId: email.id});
            }
            return email;
        },
        onSuccess: (email) => {
            if (email.mailbox === 'trash') {
                invalidateMailDeleted(queryClient, email.id, 'trash');
            } else {
                invalidateMailMoved(queryClient, email.id, email.mailbox, 'trash');
            }
        },
    });
}

export function useToggleReadEmail() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({email, isRead}: { email: Email, isRead: boolean }) => {
            if (isRead === email.isRead) {
                return email;
            }
            await mailApi.message.read.put({
                messageId: email.id,
                read: isRead
            });
            return email;
        },
        onSuccess: (email) => invalidateMailReadChanged(queryClient, email.id, email.mailbox),
    });
}

export function useMoveEmail() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({email, mailbox}: { email: Email, mailbox: string }) => {
            await mailApi.message.move.put({
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
        window.location.href = `${import.meta.env.VITE_APP_MAIL_URL}/box/inbox?mode=compose&to=${address}`;
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

export function invalidateDraftUpdated(queryClient: QueryClient, messageId: string): void {
    queryClient.invalidateQueries({queryKey: emailKeys.list('drafts')});
    queryClient.invalidateQueries({queryKey: emailKeys.detail(messageId)});
}
