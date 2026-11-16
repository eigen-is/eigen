// The chat app's queries and mutations: the sidebar's chat sections, a room's paged messages, posting, editing and
// deleting them, and creating, finding and inviting to rooms. Contacts' "start a chat" and the wizards call these
// too. Every write invalidates the caches it changes.

import { skipToken, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { chatApi, openDocument } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { useMyTeams } from '@workspace/lib/home';
import type { ChatAttachment, ChatMatch, ChatMessage } from '@workspace/lib/types/chat';
import type { DrivePath } from '@workspace/lib/types/drive';
import { EIGEN_DOC_TYPE_INFO, withEigenExtension } from '@workspace/lib/types/drive';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { useMemo } from 'react';
import { AppError, onMutationError } from '../../api-error';
import { driveKeys, invalidateItemCreated } from '../../drive/hooks/keys';
import { mountMimeContentQueryConfig, useAggregateMimeContent } from '../../drive/hooks/reads';
import { CREATE_TIMEOUT_MS, createWithReconcile, fetchListingOnce } from '../../drive/reconcile-create';
import { publicUserKeys } from '../../public/hooks/keys';
import { fetchPublicUser } from '../../public/user-batcher';
import { chatKeys, invalidateChatMatches, invalidateMessages } from './keys';

const MESSAGE_PAGE_SIZE = 50;
const CHAT_MIME_SLUG = EIGEN_DOC_TYPE_INFO.chat.urlSlug;

type ChatSections = {
    personal: DrivePath[];
    teams: { id: string; name: string; chats: DrivePath[] }[];
};

// One aggregate request for the personal and team chats, split into sidebar sections that keep its newest-first
// order. A closed wizard passes `enabled` false to skip the fetch.
export function useChatSections(enabled: boolean = true): ChatSections & { isLoading: boolean } {
    const { data: chats, isLoading } = useAggregateMimeContent(CHAT_MIME_SLUG, STALE_TIME.ONE_MINUTE, enabled);
    const { data: myTeams, isLoading: teamsLoading } = useMyTeams();
    return useMemo(() => {
        const sections = groupChatsBySection(chats ?? [], myTeams ?? []);
        return { ...sections, isLoading: isLoading || teamsLoading };
    }, [chats, isLoading, myTeams, teamsLoading]);
}

// One section per team in useMyTeams order, empty teams left out, and a personal section for the rest: the user's
// own chats and those other users shared, which carry the sharer's ownerId.
function groupChatsBySection(chats: DrivePath[], teams: readonly { id: string; name: string }[]): ChatSections {
    const personal: DrivePath[] = [];
    const byTeamOwner = new Map<string, DrivePath[]>();
    for (const team of teams) byTeamOwner.set(teamOwnerId(team.id), []);
    for (const chat of chats) {
        const teamChats = byTeamOwner.get(chat.ownerId);
        if (teamChats) teamChats.push(chat);
        else personal.push(chat);
    }
    const teamSections: ChatSections['teams'] = [];
    for (const team of teams) {
        const teamChats = byTeamOwner.get(teamOwnerId(team.id));
        if (teamChats?.length) teamSections.push({ id: team.id, name: team.name, chats: teamChats });
    }
    return { personal, teams: teamSections };
}

// Every chat in sidebar order, for the chat index's auto-open. Empty while loading, as until the teams load a
// team's chats sit among the personal ones and the wrong chat would open first.
export function useAllChats(): { chats: DrivePath[]; isLoading: boolean } {
    const { personal, teams, isLoading } = useChatSections();
    return useMemo(
        () => ({ chats: isLoading ? [] : [...personal, ...teams.flatMap((t) => t.chats)], isLoading }),
        [personal, teams, isLoading],
    );
}

export function useMessages(ownerId: string, mountId: string, chatId: string | undefined) {
    return useInfiniteQuery({
        queryKey: chatKeys.messages(ownerId, mountId, chatId || ''),
        queryFn:
            chatId && ownerId && mountId
                ? async ({ pageParam }: { pageParam: string | undefined }): Promise<ChatMessage[]> => {
                      const query: { before?: string; limit?: number } = { limit: MESSAGE_PAGE_SIZE };
                      if (pageParam) query.before = pageParam;
                      const response = await chatApi({ ownerId })({ mountId })({ chatId }).messages.get({ query });
                      if (response.error) throw new AppError(response);
                      return response.data;
                  }
                : skipToken,
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (lastPage: ChatMessage[]) => {
            if (lastPage.length < MESSAGE_PAGE_SIZE) return undefined;
            return lastPage[0]?.id;
        },
        staleTime: STALE_TIME.ONE_MINUTE,
    });
}

export function usePostMessage(ownerId: string, mountId: string, chatId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (body: {
            content: string;
            type?: 'message' | 'emote' | 'whisper';
            whisperTo?: string;
            replyTo?: string;
            attachments?: ChatAttachment[];
        }) => {
            const response = await chatApi({ ownerId })({ mountId })({ chatId }).messages.post(body);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => {
            invalidateMessages(queryClient, ownerId, mountId, chatId);
        },
        onError: onMutationError,
    });
}

// One config, so the live query and useStartChatWith's one-shot fetch share a cache entry.
function byMembersQueryConfig(ownerId: string, emails: readonly string[]) {
    return {
        queryKey: chatKeys.byMembers(ownerId, emails),
        queryFn: async (): Promise<ChatMatch[]> => {
            const response = await chatApi({ ownerId }).rooms['by-members'].get({
                query: { emails: emails.join(',') },
            });
            if (response.error) throw new AppError(response);
            return response.data.matches;
        },
        enabled: emails.length > 0 && !!ownerId,
        staleTime: STALE_TIME.THIRTY_SECONDS,
    };
}

// The chats with exactly these members, writable ones first and then the newest, so the wizard can open one
// instead of making a duplicate.
export function useFindChatByMembers(ownerId: string, emails: readonly string[]) {
    return useQuery<ChatMatch[]>(byMembersQueryConfig(ownerId, emails));
}

// The server creates the chat already shared with the members. A create that times out looks for its chat by name
// among the chats that weren't there before it.
export function useCreateChatRoom(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({
            parentId,
            fileName,
            members,
            dedupeName,
        }: {
            parentId?: string;
            fileName: string;
            members: string[];
            dedupeName?: boolean;
        }): Promise<DrivePath> =>
            createWithReconcile({
                create: async () => {
                    const response = await chatApi({ ownerId })({ mountId }).rooms.post(
                        { parentId, fileName, members, dedupeName },
                        { fetch: { signal: AbortSignal.timeout(CREATE_TIMEOUT_MS) } },
                    );
                    if (response.error) throw new AppError(response);
                    return response.data;
                },
                // Without a parentId the route picks a `chats` folder whose id no client knows, so this
                // reconciles over the mount's chat listing, narrowed to the folder when one was named.
                listFolder: async () => {
                    const chats = await fetchListingOnce(
                        queryClient,
                        mountMimeContentQueryConfig(ownerId, mountId, CHAT_MIME_SLUG),
                    );
                    return parentId ? chats.filter((chat) => chat.parentId === parentId) : chats;
                },
                // With dedupeName the server may suffix a colliding name, such as `Name (2)`, so there is no name to find.
                expectedName: dedupeName ? undefined : withEigenExtension(fileName, 'chat'),
            }),
        onSuccess: (data) => {
            invalidateItemCreated(queryClient, ownerId, mountId, data.parentId, data.mimeType);
            invalidateChatMatches(queryClient, ownerId);
        },
        // The wizard shows a duplicate name's 409 beside the field, so a toast would say it twice.
        onError: (error) => {
            if (error instanceof AppError && error.status === 409) return;
            onMutationError(error);
        },
    });
}

// It prefers the address of a registered account, as the first one may be an alias and rooms match on the account's.
// One writable match opens; otherwise the caller opens the wizard with that address.
export function useStartChatWith(): (emails: readonly string[]) => Promise<'opened' | { email: string }> {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';
    const myEmail = (user?.email ?? '').toLowerCase();

    return async (emails) => {
        const list = emails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0);
        // The lookups batch into one request, and an address with no account stays cached as null.
        const resolved = await Promise.all(
            list.map((e) =>
                queryClient
                    .fetchQuery({
                        queryKey: publicUserKeys.detail(e),
                        queryFn: () => fetchPublicUser(e),
                        staleTime: Infinity,
                    })
                    .catch(() => null),
            ),
        );
        const account = resolved.find((u) => u);
        const email = account ? account.email.toLowerCase() : (list[0] ?? '');
        // The user is never their own counterpart, and a target of only themselves would match every unshared chat.
        if (!ownerId || !email || email === myEmail) return { email };
        // A failed lookup degrades to "no matches" so the caller falls through to opening the wizard.
        const matches = await queryClient
            .fetchQuery(byMembersQueryConfig(ownerId, [email]))
            .catch((): ChatMatch[] => []);
        const writable = matches.filter((m) => m.canWrite);
        if (writable.length === 1) {
            openDocument(writable[0].path);
            return 'opened';
        }
        return { email };
    };
}

export function useInviteToChat(ownerId: string, mountId: string, chatId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ email }: { email: string }) => {
            const response = await chatApi({ ownerId })({ mountId })({ chatId }).invite.post({ email });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: driveKeys.path(ownerId, mountId, chatId) });
        },
        onError: onMutationError,
    });
}

export function useEditMessage(ownerId: string, mountId: string, chatId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ messageId, content }: { messageId: string; content: string }) => {
            const response = await chatApi({ ownerId })({ mountId })({ chatId })
                .messages({ messageId })
                .patch({ content });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => {
            invalidateMessages(queryClient, ownerId, mountId, chatId);
        },
        onError: onMutationError,
    });
}

export function useDeleteMessage(ownerId: string, mountId: string, chatId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (messageId: string) => {
            const response = await chatApi({ ownerId })({ mountId })({ chatId }).messages({ messageId }).delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => {
            invalidateMessages(queryClient, ownerId, mountId, chatId);
        },
        onError: onMutationError,
    });
}
