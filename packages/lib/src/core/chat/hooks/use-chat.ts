import { type QueryClient, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { chatApi, driveApi } from '@workspace/lib/api';
import { useMyTeams } from '@workspace/lib/home';
import type { ChatAttachment, ChatMessage } from '@workspace/lib/types/chat';
import { DRIVE_MIME_CHAT, type DrivePath, EIGEN_DOC_TYPE_INFO } from '@workspace/lib/types/drive';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { useMemo } from 'react';
import { AppError, onMutationError } from '../../api-error';
import { driveKeys, invalidateItemCreated, useAggregateMimeContent } from '../../drive/hooks/use-drive';

const MESSAGE_PAGE_SIZE = 50;
const CHAT_MIME_SLUG = EIGEN_DOC_TYPE_INFO.chat.urlSlug; // 'application-eigenchat'

export const chatKeys = {
    all: ['chat'] as const,
    owner: (ownerId: string) => [...chatKeys.all, ownerId] as const,
    messages: (ownerId: string, mountId: string, chatId: string) =>
        [...chatKeys.owner(ownerId), 'messages', mountId, chatId] as const,
};

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
export function useChatSections(): ChatSections & { isLoading: boolean } {
    // Chat sidebar wants fresher data than drive-folder browsing: 1 min instead of the 5-min default.
    const { data: chats, isLoading } = useAggregateMimeContent(CHAT_MIME_SLUG, 60_000);
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
        staleTime: 60_000,
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

export function useCreateChat(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ parentId, fileName }: { parentId: string; fileName: string }): Promise<DrivePath> => {
            const response = await driveApi({ ownerId })({ mountId })
                .folder({ pathId: parentId })
                .create({ type: 'chat' })
                .post({ fileName });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, variables) =>
            invalidateItemCreated(queryClient, ownerId, mountId, variables.parentId, DRIVE_MIME_CHAT),
        onError: onMutationError,
    });
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

// SSE invalidation functions
export function invalidateMessages(queryClient: QueryClient, ownerId: string, mountId: string, chatId: string): void {
    queryClient.invalidateQueries({ queryKey: chatKeys.messages(ownerId, mountId, chatId) });
}
