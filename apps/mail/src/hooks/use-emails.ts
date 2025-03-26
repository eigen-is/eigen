import {useQuery} from '@tanstack/react-query';
import {mailApi} from '@workspace/lib/api.ts';

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
            mailboxPath = mailboxPath === 'inbox' ? '' : mailboxPath;
            console.log(`Fetching emails for mailbox: ${mailboxPath}`);
            // @ts-ignore
            const response = await mailApi.mailbox[mailboxPath].get();
            return response.data || [];
        }
    });
}

// Hook to fetch a specific email by ID
export function useEmail(messageId: string | undefined) {
    return useQuery({
        queryKey: emailKeys.detail(messageId || ''),
        queryFn: async () => {
            if (!messageId) return null;
            const response = await mailApi.message[messageId].get();
            return response.data || null;
        },
        enabled: !!messageId,
        staleTime: 60000, // 1 minute
    });
}
