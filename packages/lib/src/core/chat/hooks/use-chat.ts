import { type QueryClient, useInfiniteQuery, useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { chatApi, driveApi } from '@workspace/lib/api';
import type { ChatAttachment, ChatMessage } from '@workspace/lib/types/chat';
import { DRIVE_MIME_CHAT, type DrivePath, EIGEN_DOC_TYPE_INFO } from '@workspace/lib/types/drive';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { AppError, onMutationError } from '../../api-error';
import { driveKeys, invalidateItemCreated, mimeContentQueryConfig, useMimeContent } from '../../drive/hooks/use-drive';

const MESSAGE_PAGE_SIZE = 50;
const CHAT_MIME_SLUG = EIGEN_DOC_TYPE_INFO.chat.urlSlug; // 'application-eigenchat'

export const chatKeys = {
    all: ['chat'] as const,
    owner: (ownerId: string) => [...chatKeys.all, ownerId] as const,
    messages: (ownerId: string, mountId: string, chatId: string) =>
        [...chatKeys.owner(ownerId), 'messages', mountId, chatId] as const,
};

export function useChats(ownerId: string) {
    // Why: chat sidebar needs fresher data than drive-folder browsing; use 1 min instead of the 5-min default.
    return useMimeContent(ownerId, CHAT_MIME_SLUG, 60_000);
}

export function useTeamsHaveChats(teamIds: string[]): boolean {
    const results = useQueries({
        queries: teamIds.map((id) => mimeContentQueryConfig(teamOwnerId(id), CHAT_MIME_SLUG)),
    });
    return results.some((q) => (q.data?.length ?? 0) > 0);
}

export function useMessages(ownerId: string, mountId: string, chatId: string | undefined) {
    return useInfiniteQuery({
        queryKey: chatKeys.messages(ownerId, mountId, chatId || ''),
        queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
            if (!chatId) return [] as ChatMessage[];
            const query: { before?: string; limit?: string } = { limit: String(MESSAGE_PAGE_SIZE) };
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
