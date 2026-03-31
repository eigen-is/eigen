import { type QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { chatApi, driveApi } from '@workspace/lib/api';
import type { ChatMessage } from '@workspace/lib/types/chat';
import type { DrivePath } from '@workspace/lib/types/drive';
import { AppError, onMutationError } from '../../api-error';
import { driveKeys, invalidateItemCreated } from '../../drive/hooks/use-drive';

const MESSAGE_PAGE_SIZE = 50;

export const chatKeys = {
    all: ['chat'] as const,
    messages: (ownerId: string, mountId: string, chatId: string) =>
        [...chatKeys.all, 'messages', ownerId, mountId, chatId] as const,
};

export function useChats(ownerId: string) {
    return useQuery<DrivePath[]>({
        queryKey: driveKeys.mime(ownerId, 'application-eigenchat'),
        queryFn: async () => {
            const response = await driveApi({ ownerId }).mime({ mimeType: 'application-eigenchat' }).get();
            return response.data || [];
        },
        enabled: !!ownerId,
    });
}

export function useMessages(ownerId: string, mountId: string, chatId: string | undefined) {
    return useInfiniteQuery({
        queryKey: chatKeys.messages(ownerId, mountId, chatId || ''),
        queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
            if (!chatId) return [] as ChatMessage[];
            const query: { before?: string; limit?: string } = { limit: String(MESSAGE_PAGE_SIZE) };
            if (pageParam) query.before = pageParam;
            const response = await chatApi({ ownerId })({ mountId })({ chatId }).messages.get({ query });
            return (response.data || []) as ChatMessage[];
        },
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (lastPage: ChatMessage[]) => {
            if (lastPage.length < MESSAGE_PAGE_SIZE) return undefined;
            return lastPage[0]?.id;
        },
        enabled: !!chatId && !!ownerId && !!mountId,
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
            attachments?: string[];
        }) => {
            const response = await chatApi({ ownerId })({ mountId })({ chatId }).messages.post(body);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: chatKeys.messages(ownerId, mountId, chatId) });
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
                .chat.post({ fileName });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, variables) =>
            invalidateItemCreated(queryClient, ownerId, mountId, variables.parentId, 'DRIVE_MIME_CHAT'),
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
            queryClient.invalidateQueries({ queryKey: chatKeys.messages(ownerId, mountId, chatId) });
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
            queryClient.invalidateQueries({ queryKey: chatKeys.messages(ownerId, mountId, chatId) });
        },
        onError: onMutationError,
    });
}

// SSE invalidation functions
export function invalidateMessages(queryClient: QueryClient, ownerId: string, mountId: string, chatId: string): void {
    queryClient.invalidateQueries({ queryKey: chatKeys.messages(ownerId, mountId, chatId) });
}
