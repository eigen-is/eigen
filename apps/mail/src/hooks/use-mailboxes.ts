import {useQuery} from '@tanstack/react-query';
import {mailApi} from '@workspace/lib/api.ts';

// Define query keys for reuse
export const mailboxKeys = {
    all: ['mailboxes'] as const,
    lists: () => [...mailboxKeys.all, 'list'] as const,
    list: (filters: Record<string, any>) => [...mailboxKeys.lists(), {filters}] as const,
    details: () => [...mailboxKeys.all, 'detail'] as const,
    detail: (id: string) => [...mailboxKeys.details(), id] as const,
    exists: (id: string) => [...mailboxKeys.detail(id), 'exists'] as const,
};

export interface Mailbox {
    path: string;
    name: string;
    flags: string[];
    total: number;
    unread: number;
    subscribed: boolean;
    children?: Mailbox[];
}

export function useMailboxes() {
    return useQuery({
        queryKey: mailboxKeys.lists(),
        queryFn: async () => {
            const response = await mailApi.mailboxes.get();
            return response.data || [];
        },
        staleTime: 60000, // 1 minute
        refetchOnWindowFocus: false,
        retry: 1,
    });
}
