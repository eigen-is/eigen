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
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { Email, EmailSummary } from '@workspace/lib/types/mail';
import { SSEventType } from '@workspace/lib/types/sse';
import { useMemo } from 'react';
import { AppError, onMutationError } from '../../api-error';
import { emailKeys, invalidateMailboxes } from './keys';

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
        // Terminate on an empty page, NOT on a short one: an optimistic move/delete removes a row
        // from the loaded page (patchEmailInLists), which would drop a full 200-row first page to
        // 199 — and a `< MAIL_PAGE_SIZE` terminator would then read that as "last page" and freeze
        // pagination after the very first archive. Keyset stays correct: the oldest remaining row is
        // always a valid cursor, and the server returns [] once past the end (one cheap trailing
        // fetch when the user scrolls to the bottom).
        getNextPageParam: (lastPage) => {
            if (lastPage.length === 0) return undefined;
            const oldest = lastPage[lastPage.length - 1];
            return { beforeDate: new Date(oldest.date).getTime(), beforeId: oldest.id };
        },
        staleTime: STALE_TIME.ONE_MINUTE,
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
        onMutate: (email) =>
            beginOptimisticMailMutation(
                queryClient,
                ownerId,
                email.id,
                'remove',
                email.mailbox === 'Trash' ? SSEventType.MAIL_DELETED : SSEventType.MAIL_MOVED,
            ),
        onSuccess: (email) => {
            if (email.mailbox === 'Trash') {
                queryClient.removeQueries({ queryKey: emailKeys.detail(ownerId, email.id) });
            } else {
                queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, email.id) });
                // Moved to Trash — the Trash list wasn't optimistically patched, so refresh it.
                queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, 'Trash') });
            }
            invalidateMailboxes(queryClient, ownerId);
        },
        onError: (error, _email, context) => {
            rollbackMailMutation(queryClient, context);
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
        onMutate: ({ email, isRead }) => {
            if (isRead === email.isRead) return;
            return beginOptimisticMailMutation(
                queryClient,
                ownerId,
                email.id,
                (e) => ({ ...e, isRead }),
                SSEventType.MAIL_READ_CHANGED,
            );
        },
        onSuccess: (email) => {
            queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, email.id) });
            invalidateMailboxes(queryClient, ownerId);
        },
        onError: (error, _vars, context) => {
            rollbackMailMutation(queryClient, context);
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
        onMutate: ({ email, isFlagged }) => {
            if (isFlagged === email.isFlagged) return;
            return beginOptimisticMailMutation(
                queryClient,
                ownerId,
                email.id,
                (e) => ({ ...e, isFlagged }),
                SSEventType.MAIL_FLAGS_CHANGED,
            );
        },
        onSuccess: (email) => queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, email.id) }),
        onError: (error, _vars, context) => {
            rollbackMailMutation(queryClient, context);
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
        onMutate: ({ email }) =>
            beginOptimisticMailMutation(queryClient, ownerId, email.id, 'remove', SSEventType.MAIL_MOVED),
        onSuccess: (email, variables) => {
            queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, email.id) });
            // The target list wasn't optimistically patched (only the source row was removed) — refresh it
            // so the moved message appears there. Usually unmounted → marked stale, refetches on next visit.
            queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, variables.mailbox) });
            invalidateMailboxes(queryClient, ownerId);
        },
        onError: (error, _vars, context) => {
            rollbackMailMutation(queryClient, context);
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
type MailMutationContext = { snapshot: [readonly unknown[], InfiniteData<EmailSummary[]> | undefined][] };

// Shared optimistic-mutation plumbing for the four mail mutations (move/delete/read/flag): cancel
// in-flight list fetches, snapshot every cached list for rollback, patch the row by id, and record
// the echo to suppress. Returns the rollback context.
export async function beginOptimisticMailMutation(
    queryClient: QueryClient,
    ownerId: string,
    messageId: string,
    patch: EmailListPatch,
    event: string,
): Promise<MailMutationContext> {
    await queryClient.cancelQueries({ queryKey: emailKeys.lists(ownerId) });
    const snapshot = queryClient.getQueriesData<InfiniteData<EmailSummary[]>>({ queryKey: emailKeys.lists(ownerId) });
    // cancelQueries on a list whose very first fetch was still in flight (no prior data) leaves it
    // stuck pending forever — TanStack doesn't auto-restart a cancelled query with no fallback data.
    // Kick those back off so a cold-open deep-link (e.g. auto-mark-as-read racing the initial inbox
    // load) can't strand the list on "No emails found" with no self-heal.
    for (const [key, data] of snapshot) {
        if (data === undefined) queryClient.refetchQueries({ queryKey: key });
    }
    patchEmailInLists(queryClient, ownerId, messageId, patch);
    markRecentMailMutation(event, messageId);
    return { snapshot };
}

function rollbackMailMutation(queryClient: QueryClient, context: MailMutationContext | undefined): void {
    if (context) for (const [key, data] of context.snapshot) queryClient.setQueryData(key, data);
}

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
