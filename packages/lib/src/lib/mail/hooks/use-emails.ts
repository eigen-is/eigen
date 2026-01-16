import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {mailApi} from '@workspace/lib/api.ts';
import {Email} from "@apps/api-server/types/mail";
import {mailboxKeys} from "./use-mailboxes.ts";
import {invalidateHomeSize} from "../../home";

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
                queryClient.invalidateQueries({queryKey: emailKeys.list('trash')});
            }
            return email;
        },
        onSuccess: (email) => {
            queryClient.invalidateQueries({queryKey: emailKeys.detail(email.id)});
            queryClient.invalidateQueries({queryKey: emailKeys.list(email.mailbox === '' ? 'inbox' : email.mailbox)});
            invalidateHomeSize(queryClient);
        }
    });
}

export function useToggleReadEmail() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({email, isRead}: {email: Email, isRead: boolean}) => {
            if (isRead === email.isRead) {
                return email;
            }
            await mailApi.message.read.put({
                messageId: email.id,
                read: isRead
            });
            return email;
        },
        onSuccess: (email) => {
            queryClient.invalidateQueries({queryKey: emailKeys.detail(email.id)});
            queryClient.invalidateQueries({queryKey: emailKeys.list(email.mailbox)});
            queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
        }
    });
}

export function useMoveEmail() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({email, mailbox}: {email: Email, mailbox: string}) => {
            const currentMailbox = email.mailbox;
            await mailApi.message.move.put({
                messageId: email.id,
                targetMailbox: mailbox
            });
            return {email, currentMailbox, mailbox};
        },
        onSuccess: ({email, currentMailbox, mailbox}) => {
            queryClient.invalidateQueries({queryKey: emailKeys.detail(email.id)});
            queryClient.invalidateQueries({queryKey: emailKeys.list(currentMailbox === '' ? 'inbox' : currentMailbox)});
            queryClient.invalidateQueries({queryKey: emailKeys.list(mailbox === '' ? 'inbox' : mailbox)});
            queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
        }
    });
}

export function useOpenWriteEmailTo() {
    return (address: string) => {
        window.location.href = `${import.meta.env.VITE_APP_MAIL_URL}/box/inbox?mode=compose&to=${address}`;
    }
}
