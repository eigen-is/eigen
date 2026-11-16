// The mail app's queries and mutations for messages: the paged mailbox list, one message, and the
// read, flag, move and delete changes. Those four patch the cached lists before the server answers,
// and the SSE handler skips the echo of a change this tab already patched in.

import type { InfiniteData, QueryClient, UseInfiniteQueryResult } from '@tanstack/react-query';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getMailComposeUrl, mailApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { MAILBOX_TRASH } from '@workspace/lib/constants/mailboxes';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { Email, EmailSummary } from '@workspace/lib/types/mail';
import type { SSEventMail } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { useMemo } from 'react';
import { AppError, onMutationError } from '../../api-error';
import { emailKeys, invalidateMailboxes } from './keys';

const MAIL_PAGE_SIZE = 200;

// The server sorts by date and then id, newest first, so a page's cursor is its oldest message's date in epoch
// milliseconds together with its id.
export function useEmails(
    mailboxPath: string,
): UseInfiniteQueryResult<InfiniteData<EmailSummary[]>> & { emails: EmailSummary[] } {
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
            // The route segment already spells the mailbox as the server reads it, and lowercasing it would lose a
            // custom folder's case.
            const response = await mailApi({ ownerId }).mailbox({ mailboxPath }).get({ query: q });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        initialPageParam: undefined as { beforeDate: number; beforeId: string } | undefined,
        // Only an empty page ends the list: an optimistic move or delete shortens a full page, which a
        // short-page check would read as the last one.
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

export function useEmailById(): (messageId: string) => Promise<Email | null> {
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
            if (email.mailbox === MAILBOX_TRASH) {
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
                email.mailbox === MAILBOX_TRASH ? SSEventType.MAIL_DELETED : SSEventType.MAIL_MOVED,
            ),
        onSuccess: (email) => {
            if (email.mailbox === MAILBOX_TRASH) {
                queryClient.removeQueries({ queryKey: emailKeys.detail(ownerId, email.id) });
            } else {
                queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, email.id) });
                // The Trash list was not patched ahead of the server, so it reloads to show the message.
                queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, MAILBOX_TRASH) });
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
        mutationFn: async ({ email, isRead }: { email: EmailSummary; isRead: boolean }) => {
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
        mutationFn: async ({ email, isFlagged }: { email: EmailSummary; isFlagged: boolean }) => {
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
            // Only the source list was patched ahead of the server, so the target list reloads to show the message.
            queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, variables.mailbox) });
            invalidateMailboxes(queryClient, ownerId);
        },
        onError: (error, _vars, context) => {
            rollbackMailMutation(queryClient, context);
            onMutationError(error);
        },
    });
}

export function useOpenWriteEmailTo(): (addresses: string | readonly string[]) => void {
    // Several addresses join into one comma-separated `to` field, which the composer splits back into recipients.
    return (addresses) => {
        const to = typeof addresses === 'string' ? addresses : addresses.join(', ');
        window.location.href = getMailComposeUrl(to);
    };
}

type EmailListPatch = ((email: EmailSummary) => EmailSummary) | 'remove';
type MailMutationContext = { snapshot: [readonly unknown[], InfiniteData<EmailSummary[]> | undefined][] };

// The fetches are cancelled before the snapshot, so a page that lands late can't overwrite the patch.
async function beginOptimisticMailMutation(
    queryClient: QueryClient,
    ownerId: string,
    messageId: string,
    patch: EmailListPatch,
    event: SSEventMail['type'],
): Promise<MailMutationContext> {
    await queryClient.cancelQueries({ queryKey: emailKeys.lists(ownerId) });
    const snapshot = queryClient.getQueriesData<InfiniteData<EmailSummary[]>>({ queryKey: emailKeys.lists(ownerId) });
    // TanStack never restarts a canceled query that had no data yet, so a list still on its first
    // fetch would stay empty for good.
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

// A message may sit in the cached list of any mailbox, so every loaded page of every list is patched. A page that
// doesn't change keeps its reference, so its rows don't render again.
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

// The server echoes every change back to this tab over SSE, which would refetch every loaded page
// for a change already patched in. Each entry is consumed once and expires, so a later change by
// another client to the same message still refreshes.
const RECENT_MAIL_MUTATION_TTL_MS = 5_000;
const recentMailMutations = new Map<string, number>();

function markRecentMailMutation(event: SSEventMail['type'], messageId: string): void {
    const now = Date.now();
    // Prune expired entries so a dropped echo can't leak them forever.
    for (const [key, expiry] of recentMailMutations) if (expiry <= now) recentMailMutations.delete(key);
    recentMailMutations.set(`${event}:${messageId}`, now + RECENT_MAIL_MUTATION_TTL_MS);
}

export function consumeRecentMailMutation(event: SSEventMail['type'], messageId: string): boolean {
    const key = `${event}:${messageId}`;
    const expiry = recentMailMutations.get(key);
    if (expiry === undefined) return false;
    recentMailMutations.delete(key);
    return expiry > Date.now();
}
