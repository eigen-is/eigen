import {useQuery, useQueryClient} from '@tanstack/react-query';
import {mailApi} from '@workspace/lib/api.ts';
import {Email} from "@apps/api-server/types/mail";
import {mailboxKeys} from "./use-mailboxes.ts";
import {Route} from "@apps/space/src/routes/_auth.user.tsx";
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
            console.log(`Fetching emails for mailbox: ${mailboxPath}`);
            // @ts-ignore
            const response = await mailApi.mailbox[mailboxPath].get();
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
            const response = await mailApi.message[messageId].get();
            return response.data || null;
        },
        enabled: !!messageId,
        staleTime: Infinity,
    });
}

export function useDeleteEmail() {
    const queryClient = useQueryClient();

    return async (email: Email) => {
        // if mail is not in the trash folder, move it to trash
        if (email.mailbox === 'trash') {
            await mailApi.message[email.id].delete();
        } else {
            await mailApi.message.moveToTrash.put({messageId: email.id});
        }
        // invalidate mailbox cache
        queryClient.invalidateQueries({queryKey: emailKeys.lists()});
        queryClient.invalidateQueries({queryKey: emailKeys.detail(email.id)});
        invalidateHomeSize(queryClient);
    }
}

export function useToggleReadEmail() {
    const queryClient = useQueryClient();

    return async (email: Email, isRead: boolean) => {
        if (isRead === email.isRead) {
            return;
        }

        await mailApi.message.read.put({
            messageId: email.id,
            read: isRead
        });
        queryClient.invalidateQueries({queryKey: emailKeys.detail(email.id)});
        queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
    }
}

export function useMoveEmail() {
    const queryClient = useQueryClient();

    return async (email: Email, mailbox: string) => {
        const currentMailbox = email.mailbox;
        await mailApi.message.move.put({
            messageId: email.id,
            targetMailbox: mailbox
        });
        queryClient.invalidateQueries({queryKey: emailKeys.detail(email.id)});
        queryClient.invalidateQueries({queryKey: emailKeys.lists()});
        queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
    }
}

export function useOpenWriteEmailTo() {
    const navigate = Route.useNavigate();
    return (address: string) => {
        navigate({
            href: `${import.meta.env.VITE_APP_MAIL_URL}/box/inbox?mode=compose&to=${address}`,
            reloadDocument: true,
            replace: true,
        });
    }
}
