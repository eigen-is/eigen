import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { chatApi, openDocument } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { useMyTeams } from '@workspace/lib/home';
import type { ChatAttachment, ChatMatch, ChatMessage } from '@workspace/lib/types/chat';
import { type DrivePath, EIGEN_DOC_TYPE_INFO, withEigenExtension } from '@workspace/lib/types/drive';
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
const CHAT_MIME_SLUG = EIGEN_DOC_TYPE_INFO.chat.urlSlug; // 'application-eigenchat'

type ChatSections = {
    personal: DrivePath[];
    teams: { id: string; name: string; chats: DrivePath[] }[];
};

// Splits the aggregate chat list into one section per team (useMyTeams order, empty teams omitted)
// and a personal catch-all: everything not owned by one of the caller's teams — own chats AND chats
// other users shared with the caller (shared_paths mirrors carry the sharer's ownerId, e.g. 1:1 chat
// invites), which have always rendered in the personal section. Pure — unit-tested.
export function groupChatsBySection(chats: DrivePath[], teams: readonly { id: string; name: string }[]): ChatSections {
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

// One aggregate request (personal + all team chats), split into sidebar sections. Both the personal
// and per-team lists keep the aggregate's updatedAt-desc order.
export function useChatSections(enabled: boolean = true): ChatSections & { isLoading: boolean } {
    // 1-min staleTime (sidebar wants fresher data); `enabled` lets closed wizards skip the fetch.
    const { data: chats, isLoading } = useAggregateMimeContent(CHAT_MIME_SLUG, STALE_TIME.ONE_MINUTE, enabled);
    const { data: myTeams, isLoading: teamsLoading } = useMyTeams();
    return useMemo(() => {
        const sections = groupChatsBySection(chats ?? [], myTeams ?? []);
        return { ...sections, isLoading: isLoading || teamsLoading };
    }, [chats, isLoading, myTeams, teamsLoading]);
}

// Flat chat list in sidebar order (personal first, then teams), for the chat index's auto-open. Empty
// while loading: until useMyTeams settles, team chats sit in the personal catch-all, so the interim
// list would auto-open the wrong "first" chat.
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
        queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
            if (!chatId) return [] as ChatMessage[];
            const query: { before?: string; limit?: number } = { limit: MESSAGE_PAGE_SIZE };
            if (pageParam) query.before = pageParam;
            const response = await chatApi({ ownerId })({ mountId })({ chatId }).messages.get({ query });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (lastPage: ChatMessage[]) => {
            if (lastPage.length < MESSAGE_PAGE_SIZE) return undefined;
            return lastPage[0]?.id;
        },
        enabled: !!chatId && !!ownerId && !!mountId,
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

// Shared by the live query and useStartChatWith's one-shot fetch so both hit one cache entry.
function byMembersQueryConfig(ownerId: string, emails: string[]) {
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

// Open-don't-duplicate lookup (writable first, then updatedAt desc); disabled until someone is picked.
export function useFindChatByMembers(ownerId: string, emails: string[]) {
    return useQuery<ChatMatch[]>(byMembersQueryConfig(ownerId, emails));
}

// Create a chat pre-shared with the picked members (server-side create + ACL in one step). A create
// that times out reconciles by name against the pre-create id snapshot.
export function useCreateChatRoom(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            parentId,
            fileName,
            members,
            dedupeName,
        }: {
            parentId?: string;
            fileName: string;
            members: string[];
            dedupeName?: boolean;
        }): Promise<DrivePath> => {
            const create = async () => {
                const response = await chatApi({ ownerId })({ mountId }).rooms.post(
                    { parentId, fileName, members, dedupeName },
                    { fetch: { signal: AbortSignal.timeout(CREATE_TIMEOUT_MS) } },
                );
                if (response.error) throw new AppError(response);
                return response.data;
            };
            // dedupeName lets the server suffix a colliding name (`Name (2)`), so the row that
            // lands is not the name we sent and nothing can honestly match — skip reconcile.
            if (dedupeName) return create();
            return createWithReconcile({
                create,
                // The wizard can omit parentId (the route resolves the lazily-created `chats`
                // folder, an id no client endpoint hands out), so reconcile over the mount-scoped
                // chat listing, narrowed to the folder whenever the caller did name one.
                listFolder: async () => {
                    const chats = await fetchListingOnce(
                        queryClient,
                        mountMimeContentQueryConfig(ownerId, mountId, CHAT_MIME_SLUG),
                    );
                    return parentId ? chats.filter((chat) => chat.parentId === parentId) : chats;
                },
                expectedName: withEigenExtension(fileName, 'chat'),
            });
        },
        // Refresh the parent folder, the sidebar aggregate, and the by-members family.
        onSuccess: (data) => {
            invalidateItemCreated(queryClient, ownerId, mountId, data.parentId, data.mimeType);
            invalidateChatMatches(queryClient, ownerId);
        },
        // 409 = duplicate name, handled inline by the wizard — don't toast twice.
        onError: (error) => {
            if (error instanceof AppError && error.status === 409) return;
            onMutationError(error);
        },
    });
}

// Contacts' "start a chat": takes the person's addresses and prefers the one that belongs to a
// registered account — email[0] can be a later-added alias, and the by-members match is keyed by
// the account address. Exactly one writable match opens directly ('opened'); otherwise the chosen
// address comes back so the caller opens the wizard pre-filled with it.
export function useStartChatWith() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';
    const myEmail = (user?.email ?? '').toLowerCase();

    return async (emails: string[]): Promise<'opened' | { email: string }> => {
        const list = emails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0);
        // Registered-account lookups batch and cache misses as null (staleTime Infinity).
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
        // Self is never a counterpart — and every unshared solo chat would match a self-only target.
        if (!ownerId || !email || email === myEmail) return { email };
        // A failed lookup degrades to "no matches" so the caller falls through to opening the wizard.
        const matches = await queryClient
            .fetchQuery(byMembersQueryConfig(ownerId, [email]))
            .catch(() => [] as ChatMatch[]);
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
            // Refresh chat path so roomMembers list updates
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
