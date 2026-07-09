import {
    type InfiniteData,
    type QueryClient,
    useInfiniteQuery,
    useMutation,
    useQuery,
    useQueryClient,
} from '@tanstack/react-query';
import { getMailComposeUrl, mailApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import type { Email, EmailSummary } from '@workspace/lib/types/mail';
import { SSEventType } from '@workspace/lib/types/sse';
import { useMemo } from 'react';
import { AppError, onMutationError } from '../../api-error';
import { invalidateMailboxes } from './use-mailboxes';

export const emailKeys = {
    all: ['emails'] as const,
    owner: (ownerId: string) => [...emailKeys.all, ownerId] as const,
    lists: (ownerId: string) => [...emailKeys.owner(ownerId), 'list'] as const,
    // toLowerCase() ensures query key consistency: sidebar URLs are lowercase (e.g. /box/sent)
    // but SSE events use canonical case (e.g. 'Sent'). Without normalization, SSE invalidation
    // would miss the cached query key, causing silent cache staleness.
    list: (ownerId: string, mailbox: string) =>
        [...emailKeys.lists(ownerId), { mailbox: mailbox.toLowerCase() }] as const,
    details: (ownerId: string) => [...emailKeys.owner(ownerId), 'detail'] as const,
    detail: (ownerId: string, id: string) => [...emailKeys.details(ownerId), id] as const,
};

const MAIL_PAGE_SIZE = 200;

// Newest-first paginated mailbox. Composite cursor (beforeDate=epoch MS, beforeId) matches the
// server's date-desc/id-desc order. Returns a flat `emails` array alongside the paging controls;
// the sole caller (the mail route) consumes the flat shape.
export function useEmails(mailboxPath: string) {
    const { user } = useAuth();
    const ownerId = user?.id || '';

    const query = useInfiniteQuery({
        queryKey: emailKeys.list(ownerId, mailboxPath),
        queryFn: async ({ pageParam }): Promise<EmailSummary[]> => {
            const q: { limit: number; beforeDate?: number; beforeId?: string } = { limit: MAIL_PAGE_SIZE };
            if (pageParam) {
                q.beforeDate = pageParam.beforeDate;
                q.beforeId = pageParam.beforeId;
            }
            const response = await mailApi({ ownerId })
                .mailbox({ mailboxPath: mailboxPath.toLowerCase() })
                .get({ query: q });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        initialPageParam: undefined as { beforeDate: number; beforeId: string } | undefined,
        getNextPageParam: (lastPage) => {
            if (lastPage.length < MAIL_PAGE_SIZE) return undefined;
            const oldest = lastPage[lastPage.length - 1];
            return { beforeDate: new Date(oldest.date).getTime(), beforeId: oldest.id };
        },
        staleTime: 60_000,
        retry: 1,
        enabled: !!ownerId,
    });

    const emails = useMemo(() => query.data?.pages.flat() ?? [], [query.data]);
    return { ...query, emails };
}

export function useEmail(messageId: string | undefined) {
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: emailKeys.detail(ownerId, messageId || ''),
        queryFn: async () => {
            if (!messageId) return null;
            const response = await mailApi({ ownerId }).message({ id: messageId }).get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!messageId && !!ownerId,
        staleTime: Infinity,
        retry: 1,
    });
}

export function useEmailById() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return async (messageId: string): Promise<Email | null> => {
        if (!ownerId) return null;
        try {
            return await queryClient.fetchQuery({
                queryKey: emailKeys.detail(ownerId, messageId),
                queryFn: async () => {
                    const response = await mailApi({ ownerId }).message({ id: messageId }).get();
                    if (response.error) throw new AppError(response);
                    return response.data;
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
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (email: Email) => {
            if (email.mailbox === 'Trash') {
                const response = await mailApi({ ownerId }).message({ id: email.id }).delete();
                if (response.error) throw new AppError(response);
            } else {
                const response = await mailApi({ ownerId }).message['move-to-trash'].put({ messageId: email.id });
                if (response.error) throw new AppError(response);
            }
            return email;
        },
        onMutate: async (email) => {
            await queryClient.cancelQueries({ queryKey: emailKeys.lists(ownerId) });
            const snapshot = queryClient.getQueriesData<InfiniteData<EmailSummary[]>>({
                queryKey: emailKeys.lists(ownerId),
            });
            patchEmailInLists(queryClient, ownerId, email.id, 'remove');
            markRecentMailMutation(
                email.mailbox === 'Trash' ? SSEventType.MAIL_DELETED : SSEventType.MAIL_MOVED,
                email.id,
            );
            return { snapshot };
        },
        onSuccess: (email) => {
            if (email.mailbox === 'Trash') {
                queryClient.removeQueries({ queryKey: emailKeys.detail(ownerId, email.id) });
            } else {
                queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, email.id) });
            }
            invalidateMailboxes(queryClient, ownerId);
        },
        onError: (error, _email, context) => {
            if (context) for (const [key, data] of context.snapshot) queryClient.setQueryData(key, data);
            onMutationError(error);
        },
    });
}

export function useToggleReadEmail() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async ({ email, isRead }: { email: Email; isRead: boolean }) => {
            if (isRead === email.isRead) {
                return email;
            }
            const response = await mailApi({ ownerId }).message({ id: email.id }).read.put({
                read: isRead,
            });
            if (response.error) throw new AppError(response);
            return email;
        },
        onMutate: async ({ email, isRead }) => {
            if (isRead === email.isRead) return;
            await queryClient.cancelQueries({ queryKey: emailKeys.lists(ownerId) });
            const snapshot = queryClient.getQueriesData<InfiniteData<EmailSummary[]>>({
                queryKey: emailKeys.lists(ownerId),
            });
            patchEmailInLists(queryClient, ownerId, email.id, (e) => ({ ...e, isRead }));
            markRecentMailMutation(SSEventType.MAIL_READ_CHANGED, email.id);
            return { snapshot };
        },
        onSuccess: (email) => {
            queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, email.id) });
            invalidateMailboxes(queryClient, ownerId);
        },
        onError: (error, _vars, context) => {
            if (context) for (const [key, data] of context.snapshot) queryClient.setQueryData(key, data);
            onMutationError(error);
        },
    });
}

export function useToggleFlaggedEmail() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async ({ email, isFlagged }: { email: Email; isFlagged: boolean }) => {
            if (isFlagged === email.isFlagged) {
                return email;
            }
            const response = await mailApi({ ownerId }).message({ id: email.id }).flagged.put({
                flagged: isFlagged,
            });
            if (response.error) throw new AppError(response);
            return email;
        },
        onMutate: async ({ email, isFlagged }) => {
            if (isFlagged === email.isFlagged) return;
            await queryClient.cancelQueries({ queryKey: emailKeys.lists(ownerId) });
            const snapshot = queryClient.getQueriesData<InfiniteData<EmailSummary[]>>({
                queryKey: emailKeys.lists(ownerId),
            });
            patchEmailInLists(queryClient, ownerId, email.id, (e) => ({ ...e, isFlagged }));
            markRecentMailMutation(SSEventType.MAIL_FLAGS_CHANGED, email.id);
            return { snapshot };
        },
        onSuccess: (email) => queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, email.id) }),
        onError: (error, _vars, context) => {
            if (context) for (const [key, data] of context.snapshot) queryClient.setQueryData(key, data);
            onMutationError(error);
        },
    });
}

export function useMoveEmail() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async ({ email, mailbox }: { email: Email; mailbox: string }) => {
            const response = await mailApi({ ownerId }).message.move.put({
                messageId: email.id,
                targetMailbox: mailbox,
            });
            if (response.error) throw new AppError(response);
            return email;
        },
        onMutate: async ({ email }) => {
            await queryClient.cancelQueries({ queryKey: emailKeys.lists(ownerId) });
            const snapshot = queryClient.getQueriesData<InfiniteData<EmailSummary[]>>({
                queryKey: emailKeys.lists(ownerId),
            });
            patchEmailInLists(queryClient, ownerId, email.id, 'remove');
            markRecentMailMutation(SSEventType.MAIL_MOVED, email.id);
            return { snapshot };
        },
        onSuccess: (email) => {
            queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, email.id) });
            invalidateMailboxes(queryClient, ownerId);
        },
        onError: (error, _vars, context) => {
            if (context) for (const [key, data] of context.snapshot) queryClient.setQueryData(key, data);
            onMutationError(error);
        },
    });
}

export function useOpenWriteEmailTo() {
    return (address: string) => {
        window.location.href = getMailComposeUrl(address);
    };
}

type EmailListPatch = ((email: EmailSummary) => EmailSummary) | 'remove';

// Patch a row by id across every cached list (sidesteps the ''/'inbox'/case mailbox-key pitfalls).
// Lists are infinite queries, so patch each loaded page and keep refs stable when unchanged.
function patchEmailInLists(queryClient: QueryClient, ownerId: string, messageId: string, patch: EmailListPatch): void {
    queryClient.setQueriesData<InfiniteData<EmailSummary[]>>({ queryKey: emailKeys.lists(ownerId) }, (data) => {
        if (!data) return data;
        let changed = false;
        const pages = data.pages.map((page) => {
            if (patch === 'remove') {
                const next = page.filter((e) => e.id !== messageId);
                if (next.length !== page.length) changed = true;
                return next;
            }
            let pageChanged = false;
            const next = page.map((e) => {
                if (e.id !== messageId) return e;
                pageChanged = true;
                changed = true;
                return patch(e);
            });
            return pageChanged ? next : page;
        });
        return changed ? { ...data, pages } : data;
    });
}

// The server echoes every mutation back to its originator over SSE, and the SSE handler would then
// invalidate the list — refetching every loaded page of the infinite query for a change we already
// patched in optimistically. Each mutation records the echo it expects here; the SSE handler consumes
// the entry and skips its list refetch. Keyed by `${event}:${messageId}`, short-TTL and consumed once so
// a genuinely later external change to the same message still refreshes. Module-level: this is a
// per-tab suppression of our OWN echo, never another client's changes.
const RECENT_MAIL_MUTATION_TTL_MS = 5_000;
const recentMailMutations = new Map<string, number>();

function markRecentMailMutation(event: string, messageId: string): void {
    const now = Date.now();
    // Prune expired entries so a dropped echo can't leak them forever.
    for (const [key, expiry] of recentMailMutations) if (expiry <= now) recentMailMutations.delete(key);
    recentMailMutations.set(`${event}:${messageId}`, now + RECENT_MAIL_MUTATION_TTL_MS);
}

export function consumeRecentMailMutation(event: string, messageId: string): boolean {
    const key = `${event}:${messageId}`;
    const expiry = recentMailMutations.get(key);
    if (expiry === undefined) return false;
    recentMailMutations.delete(key);
    return expiry > Date.now();
}

// Invalidation functions (ownerId-scoped, used from mutation onSuccess)
export function invalidateMailReceived(queryClient: QueryClient, ownerId: string, mailbox: string = 'inbox'): void {
    queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, mailbox) });
}

export function invalidateMailDeleted(
    queryClient: QueryClient,
    ownerId: string,
    messageId: string,
    mailbox: string,
): void {
    queryClient.removeQueries({ queryKey: emailKeys.detail(ownerId, messageId) });
    queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, mailbox) });
}

export function invalidateMailMoved(
    queryClient: QueryClient,
    ownerId: string,
    messageId: string,
    fromMailbox: string,
    toMailbox: string | null | undefined,
): void {
    queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, messageId) });
    queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, fromMailbox) });
    if (toMailbox) {
        queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, toMailbox) });
    }
}

export function invalidateMailReadChanged(
    queryClient: QueryClient,
    ownerId: string,
    messageId: string,
    mailbox: string,
): void {
    queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, messageId) });
    queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, mailbox) });
}

export function invalidateMailFlagsChanged(
    queryClient: QueryClient,
    ownerId: string,
    messageId: string,
    mailbox: string,
): void {
    queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, messageId) });
    queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, mailbox) });
}

export function invalidateDraftUpdated(queryClient: QueryClient, ownerId: string, messageId: string): void {
    queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, 'Drafts') });
    queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, messageId) });
}
