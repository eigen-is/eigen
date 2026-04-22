import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ChatAttachment, ChatMessage, RoomMember } from '../../../types/chat';
import { isAttachmentReference } from '../../../types/chat';
import type { DrivePath } from '../../../types/drive';
import { isContainerType, isFolderType } from '../../../types/drive';
import { validateEmailTarget } from '../../../validation';
import { driveApi } from '../../api';
import { useAuth } from '../../auth';
import {
    invalidateItemCreated,
    useCheckPermissions,
    useEffectiveMembers,
    useFolderContent,
    usePathInfo,
    useUploadFile,
} from '../../drive';
import { COMMANDS_HELP, getLocalCommand, isUnknownCommand } from '../commands';
import { useDeleteMessage, useEditMessage, useInviteToChat, useMessages, usePostMessage } from './use-chat';
import { useAutoMarkChatRead } from './use-chat-unread';

let localIdCounter = 0;

export function useChatRoom(ownerId: string, mountId: string, chatId: string) {
    const { user } = useAuth();

    const messagesQuery = useMessages(ownerId, mountId, chatId);
    // Pages are [latest, older, oldest...] — reverse then flatten for chronological order
    const messages = useMemo(() => {
        const pages = messagesQuery.data?.pages ?? [];
        return [...pages].reverse().flat();
    }, [messagesQuery.data]);
    const isLoading = messagesQuery.isLoading;
    const postMessage = usePostMessage(ownerId, mountId, chatId);
    const uploadFile = useUploadFile(ownerId, mountId);
    const { data: chatPath } = usePathInfo(ownerId, mountId, chatId);
    const inviteToChat = useInviteToChat(ownerId, mountId, chatId);
    const deleteMessage = useDeleteMessage(ownerId, mountId, chatId);
    const editMessage = useEditMessage(ownerId, mountId, chatId);
    const { data: permissions } = useCheckPermissions(ownerId, mountId, chatId);
    const readOnly = permissions ? !permissions.canWrite : false;
    const { data: chatContents = [] } = useFolderContent(ownerId, mountId, chatId);

    const queryClient = useQueryClient();
    const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
    const [pendingDriveAttachments, setPendingDriveAttachments] = useState<ChatAttachment[]>([]);
    const lastWhisperFromRef = useRef<string | null>(null);

    useEffect(() => {
        setLocalMessages([]);
        setPendingDriveAttachments([]);
        lastWhisperFromRef.current = null;
    }, [chatId]);

    const chatName = chatPath?.name?.replace('.eigenchat', '') || 'Chat';

    useAutoMarkChatRead(user?.id ?? '', chatId);

    const { data: effectiveMembers } = useEffectiveMembers(ownerId, mountId, chatId);
    const roomMembers: RoomMember[] = useMemo(() => {
        if (!effectiveMembers) return [];
        return effectiveMembers.map((m) => ({
            email: m.email,
            displayName: m.email.split('@')[0],
        }));
    }, [effectiveMembers]);

    const addLocalMessage = useCallback((content: string) => {
        const msg: ChatMessage = {
            id: `local-${++localIdCounter}`,
            authorId: 'system',
            authorEmail: 'system',
            type: 'system',
            content,
            attachments: null,
            whisperTo: null,
            replyTo: null,
            editedAt: null,
            deletedAt: null,
            createdAt: new Date(),
        };
        setLocalMessages((prev) => [...prev, msg]);
    }, []);

    const findLastWhisperFrom = useCallback(() => {
        if (lastWhisperFromRef.current) return lastWhisperFromRef.current;
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.type === 'whisper' && msg.whisperTo === user?.email && msg.authorEmail) {
                return msg.authorEmail;
            }
        }
        return null;
    }, [messages, user?.email]);

    const addDriveAttachments = useCallback(
        async (paths: DrivePath[]) => {
            const mediaFolder = chatContents.find((item) => item.name === 'media');
            if (!mediaFolder) return;

            const refs: ChatAttachment[] = [];
            const filesToCopy: DrivePath[] = [];

            for (const path of paths) {
                if (isContainerType(path.type) || isFolderType(path.type)) {
                    refs.push({
                        type: 'reference',
                        ownerId: path.ownerId,
                        mountId: path.mountId,
                        id: path.id,
                        name: path.name,
                        driveType: path.type,
                        mimeType: path.mimeType,
                    });
                } else {
                    filesToCopy.push(path);
                }
            }

            if (refs.length > 0) {
                setPendingDriveAttachments((prev) => [...prev, ...refs]);
            }

            if (filesToCopy.length > 0) {
                const results = await Promise.allSettled(
                    filesToCopy.map(async (path) => {
                        const response = await driveApi({ ownerId: path.ownerId })({ mountId: path.mountId })
                            .file({ pathId: path.id })
                            .copy.post({
                                targetOwnerId: ownerId,
                                targetMountId: mountId,
                                targetParentId: mediaFolder.id,
                            });
                        if (response.error) throw response.error;
                        return path.name;
                    }),
                );
                const names = results
                    .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
                    .map((r) => r.value);
                if (names.length > 0) {
                    setPendingDriveAttachments((prev) => [...prev, ...names]);
                    invalidateItemCreated(queryClient, ownerId, mountId, mediaFolder.id);
                }
                if (names.length < filesToCopy.length) {
                    toast.error('Some files could not be attached');
                }
            }
        },
        [ownerId, mountId, chatContents, queryClient],
    );

    const removeDriveAttachment = useCallback((attachment: ChatAttachment) => {
        setPendingDriveAttachments((prev) =>
            prev.filter((a) => {
                if (typeof a === 'string' && typeof attachment === 'string') return a !== attachment;
                if (isAttachmentReference(a) && isAttachmentReference(attachment)) return a.id !== attachment.id;
                return true;
            }),
        );
    }, []);

    const handleSendMessage = useCallback(
        async (rawContent: string, files?: File[]) => {
            if (!rawContent.trim() && (!files || files.length === 0) && pendingDriveAttachments.length === 0) return;

            let attachments: ChatAttachment[] | undefined;

            if (pendingDriveAttachments.length > 0) {
                attachments = [...pendingDriveAttachments];
                setPendingDriveAttachments([]);
            }

            if (files && files.length > 0 && chatPath) {
                const mediaFolder = chatContents.find((item) => item.name === 'media');
                if (mediaFolder) {
                    const uploaded = await Promise.all(
                        files.map((file) => uploadFile.mutateAsync({ parentId: mediaFolder.id, file })),
                    );
                    const uploadedNames = uploaded.filter(Boolean).map((u) => u.name);
                    attachments = [...(attachments ?? []), ...uploadedNames];
                }
            }

            if (isUnknownCommand(rawContent)) {
                addLocalMessage(`Unknown command: ${rawContent.split(' ')[0]}\nType /help to see available commands.`);
                return;
            }

            const local = getLocalCommand(rawContent);
            if (local) {
                switch (local.kind) {
                    case 'error': {
                        addLocalMessage(local.error);
                        return;
                    }
                    case 'help': {
                        const lines = COMMANDS_HELP.map((c) => `  ${c.cmd}  —  ${c.desc}`).join('\n');
                        addLocalMessage(`Available commands:\n${lines}`);
                        return;
                    }
                    case 'inspect': {
                        addLocalMessage(`inspect:${local.target}`);
                        return;
                    }
                    case 'reply': {
                        const target = findLastWhisperFrom();
                        if (!target) {
                            addLocalMessage('No one has whispered to you yet.');
                            return;
                        }
                        lastWhisperFromRef.current = target;
                        await postMessage.mutateAsync({
                            content: local.content,
                            type: 'whisper',
                            whisperTo: target,
                            attachments,
                        });
                        return;
                    }
                    case 'invite': {
                        if (!chatPath) return;
                        const inviteError = validateEmailTarget(local.target, 'Invite');
                        if (inviteError) {
                            addLocalMessage(inviteError);
                            return;
                        }
                        try {
                            const result = await inviteToChat.mutateAsync({ email: local.target });
                            if (result?.alreadyHasAccess) {
                                addLocalMessage(`${local.target} already has access.`);
                            } else {
                                addLocalMessage(`You invited ${local.target}.`);
                            }
                        } catch {
                            addLocalMessage(`Failed to invite ${local.target}.`);
                        }
                        return;
                    }
                }
            }

            await postMessage.mutateAsync({ content: rawContent, attachments });
        },
        [
            ownerId,
            mountId,
            chatId,
            chatPath,
            chatContents,
            pendingDriveAttachments,
            uploadFile,
            postMessage,
            inviteToChat,
            addLocalMessage,
            findLastWhisperFrom,
        ],
    );

    const allMessages = useMemo(() => {
        return [...messages, ...localMessages].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
    }, [messages, localMessages]);

    const mediaFolderId = chatContents.find((item) => item.name === 'media')?.id ?? null;

    const handleDeleteMessage = useCallback(
        (messageId: string) => deleteMessage.mutateAsync(messageId),
        [deleteMessage],
    );

    const handleEditMessage = useCallback(
        (messageId: string, content: string) => editMessage.mutateAsync({ messageId, content }),
        [editMessage],
    );

    return {
        messages: allMessages,
        isLoading,
        chatName,
        chatPath,
        roomMembers,
        readOnly,
        disabled: postMessage.isPending || uploadFile.isPending,
        currentUserId: user?.id || '',
        currentUserEmail: user?.email || '',
        mediaFolderId,
        handleSendMessage,
        handleEditMessage,
        handleDeleteMessage,
        hasOlderMessages: messagesQuery.hasNextPage,
        isFetchingOlderMessages: messagesQuery.isFetchingNextPage,
        fetchOlderMessages: messagesQuery.fetchNextPage,
        driveAttachments: pendingDriveAttachments,
        addDriveAttachments,
        removeDriveAttachment,
    };
}
