import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {chatApi, driveApi} from "@workspace/lib/api";
import {driveKeys, invalidateItemCreated} from "../../drive/hooks/use-drive";
import type {DrivePath} from "@workspace/lib/types/drive";
import type {ChatMessage} from "@workspace/lib/types/chat";

export const chatKeys = {
    all: ['chat'] as const,
    messages: (ownerId: string, mountId: string, chatId: string) =>
        [...chatKeys.all, 'messages', ownerId, mountId, chatId] as const,
    file: (pathId: string) => [...chatKeys.all, 'file', pathId] as const,
};

export function useOwnChats(ownerId: string) {
    return useQuery({
        queryKey: [...driveKeys.mime('application-eigenchat'), 'own'],
        queryFn: async () => {
            const response = await driveApi({ownerId}).mime({mimeType: 'application-eigenchat'}).get();
            const all = (response.data || []) as DrivePath[];
            return all.filter(p => p.ownerId === ownerId);
        },
        enabled: !!ownerId,
    });
}

export function useSharedChats(ownerId: string) {
    return useQuery({
        queryKey: [...driveKeys.shared('with-me'), 'chats'],
        queryFn: async () => {
            const response = await driveApi({ownerId}).shared['with-me'].get();
            const all = (response.data || []) as DrivePath[];
            return all.filter(p => p.mimeType === 'application/eigenchat');
        },
        enabled: !!ownerId,
    });
}

export function useChats(ownerId: string) {
    const own = useOwnChats(ownerId);
    const shared = useSharedChats(ownerId);
    const sharedIds = new Set((shared.data || []).map(c => c.id));
    const myChats = (own.data || []).filter(c => !sharedIds.has(c.id));

    return {
        myChats,
        sharedChats: shared.data || [],
        isLoading: own.isLoading || shared.isLoading,
    };
}

export function useMessages(ownerId: string, mountId: string, chatId: string | undefined) {
    return useQuery({
        queryKey: chatKeys.messages(ownerId, mountId, chatId || ''),
        queryFn: async () => {
            if (!chatId) return [];
            const response = await chatApi({ownerId})({mountId})({chatId}).messages.get();
            return (response.data || []) as ChatMessage[];
        },
        enabled: !!chatId && !!ownerId && !!mountId,
        refetchInterval: 5000,
    });
}

export function usePostMessage(ownerId: string, mountId: string, chatId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (body: { content: string; type?: 'message' | 'emote' | 'whisper' | 'system'; whisperTo?: string; replyTo?: string; attachments?: string[] }) => {
            const response = await chatApi({ownerId})({mountId})({chatId}).messages.post(body);
            return response.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: chatKeys.messages(ownerId, mountId, chatId)});
        },
    });
}

export function useFileInfo(ownerId: string, mountId: string, pathId: string) {
    return useQuery({
        queryKey: chatKeys.file(pathId),
        queryFn: async () => {
            const res = await driveApi({ownerId})({mountId}).file({pathId}).get();
            return res.data as DrivePath | null;
        },
        staleTime: 60_000,
        enabled: !!pathId && !!ownerId && !!mountId,
    });
}

export function useCreateChat(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({parentId, fileName}: { parentId: string; fileName: string }) => {
            const response = await driveApi({ownerId})({mountId}).folder({pathId: parentId}).chat.post({fileName});
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateItemCreated(queryClient, mountId, variables.parentId, 'application/eigenchat'),
    });
}
