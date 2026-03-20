import {type QueryClient, useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {chatApi, driveApi} from "@workspace/lib/api";
import {driveKeys, invalidateItemCreated} from "../../drive/hooks/use-drive";
import type {DrivePath} from "@workspace/lib/types/drive";
import type {ChatMessage} from "@workspace/lib/types/chat";
import {AppError, onMutationError} from '../../api-error';

export const chatKeys = {
    all: ['chat'] as const,
    messages: (ownerId: string, mountId: string, chatId: string) =>
        [...chatKeys.all, 'messages', ownerId, mountId, chatId] as const,
};

export function useChats(ownerId: string) {
    return useQuery<DrivePath[]>({
        queryKey: driveKeys.mime(ownerId, 'application-eigenchat'),
        queryFn: async () => {
            const response = await driveApi({ownerId}).mime({mimeType: 'application-eigenchat'}).get();
            return response.data || [];
        },
        enabled: !!ownerId,
    });
}

export function useMessages(ownerId: string, mountId: string, chatId: string | undefined) {
    return useQuery<ChatMessage[]>({
        queryKey: chatKeys.messages(ownerId, mountId, chatId || ''),
        queryFn: async () => {
            if (!chatId) return [];
            const response = await chatApi({ownerId})({mountId})({chatId}).messages.get();
            return response.data || [];
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
            attachments?: string[]
        }) => {
            const response = await chatApi({ownerId})({mountId})({chatId}).messages.post(body);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: chatKeys.messages(ownerId, mountId, chatId)});
        },
        onError: onMutationError,
    });
}

export function useCreateChat(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({parentId, fileName}: { parentId: string; fileName: string }): Promise<DrivePath> => {
            const response = await driveApi({ownerId})({mountId}).folder({pathId: parentId}).chat.post({fileName});
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateItemCreated(queryClient, ownerId, mountId, variables.parentId, 'DRIVE_MIME_CHAT'),
        onError: onMutationError,
    });
}

// SSE invalidation functions
export function invalidateMessages(queryClient: QueryClient, ownerId: string, mountId: string, chatId: string): void {
    queryClient.invalidateQueries({queryKey: chatKeys.messages(ownerId, mountId, chatId)});
}
