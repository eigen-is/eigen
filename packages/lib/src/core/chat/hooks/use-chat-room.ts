// Everything a chat room view needs, in one hook: the messages in order, the members, the attachments waiting to be
// sent, and the send handler, which also runs slash commands such as /help or /invite. Such a command leaves the
// attachments waiting. A chat file and a comment thread on a document both render through it. Its state belongs to one
// room, so the component that calls it is keyed by the chat's id.

import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import { CONTAINER_MEDIA_FOLDER } from '../../../constants/container';
import type { ChatAttachment, ChatMessage, RoomMember } from '../../../types/chat';
import { isAttachmentReference } from '../../../types/chat';
import type { DrivePath } from '../../../types/drive';
import { isContainerType, stripEigenExtension } from '../../../types/drive';
import { toAttachmentReference } from '../../../types/drive-reference';
import { validateEmailTarget } from '../../../validation';
import { useAuth } from '../../auth';
import {
    useCheckPermissions,
    useCopyToMediaFolder,
    useEffectiveMembers,
    useFolderContent,
    usePathInfo,
    useUploadFile,
} from '../../drive';
import { usePublicUsers } from '../../public';
import { COMMANDS_HELP, getLocalCommand, isUnknownCommand } from '../commands';
import { useDeleteMessage, useEditMessage, useInviteToChat, useMessages, usePostMessage } from './use-chat';
import { useAutoMarkChatRead } from './use-chat-unread';

let localIdCounter = 0;

// `containerPathId` is set for a comment thread. It is the document the thread comments on, and the
// thread's notifications are tagged with it. A standalone chat is tagged with itself.
export type ChatRoomState = {
    messages: ChatMessage[];
    isLoading: boolean;
    chatName: string;
    chatPath: DrivePath | null | undefined;
    roomMembers: RoomMember[];
    readOnly: boolean;
    disabled: boolean;
    currentUserEmail: string;
    mediaFolderId: string | null;
    handleSendMessage: (rawContent: string, files?: readonly File[]) => Promise<boolean>;
    handleEditMessage: (messageId: string, content: string) => Promise<ChatMessage>;
    handleDeleteMessage: (messageId: string) => Promise<{ success: boolean }>;
    hasOlderMessages: boolean;
    isFetchingOlderMessages: boolean;
    fetchOlderMessages: UseInfiniteQueryResult<InfiniteData<ChatMessage[]>>['fetchNextPage'];
    driveAttachments: ChatAttachment[];
    addDriveAttachments: (paths: readonly DrivePath[]) => Promise<void>;
    removeDriveAttachment: (attachment: ChatAttachment) => void;
};

export function useChatRoom(ownerId: string, mountId: string, chatId: string, containerPathId?: string): ChatRoomState {
    const { user } = useAuth();

    const messagesQuery = useMessages(ownerId, mountId, chatId);
    // The pages come newest first, so they are reversed before flattening to read oldest first.
    const messages = useMemo(() => {
        const pages = messagesQuery.data?.pages ?? [];
        return [...pages].reverse().flat();
    }, [messagesQuery.data]);
    const postMessage = usePostMessage(ownerId, mountId, chatId);
    const uploadFile = useUploadFile(ownerId, mountId);
    const { mutateAsync: copyToMediaFolder } = useCopyToMediaFolder(ownerId, mountId);
    const { data: chatPath } = usePathInfo(ownerId, mountId, chatId);
    const inviteToChat = useInviteToChat(ownerId, mountId, chatId);
    const deleteMessage = useDeleteMessage(ownerId, mountId, chatId);
    const editMessage = useEditMessage(ownerId, mountId, chatId);
    const { data: permissions } = useCheckPermissions(ownerId, mountId, chatId);
    const readOnly = permissions ? !permissions.canWrite : false;
    const { data: chatContents = [] } = useFolderContent(ownerId, mountId, chatId);

    const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
    const [pendingDriveAttachments, setPendingDriveAttachments] = useState<ChatAttachment[]>([]);
    const lastWhisperFromRef = useRef<string | null>(null);

    const chatName = chatPath ? stripEigenExtension(chatPath.name) : 'Chat';

    // The tag carries the chat's file name, not the stripped label the header shows.
    useAutoMarkChatRead(user?.id ?? '', containerPathId ?? chatId, containerPathId ? chatPath?.name : undefined);

    const { data: effectiveMembers } = useEffectiveMembers(ownerId, mountId, chatId);
    const memberEmails = useMemo(() => (effectiveMembers ?? []).map((m) => m.email), [effectiveMembers]);
    const publicMembers = usePublicUsers(memberEmails);
    const roomMembers: RoomMember[] = useMemo(() => {
        if (!effectiveMembers) return [];
        return effectiveMembers.map((m) => ({
            email: m.email,
            displayName: publicMembers[m.email]?.name || m.email.split('@')[0],
        }));
    }, [effectiveMembers, publicMembers]);

    const addLocalMessage = useCallback((content: string) => {
        const msg: ChatMessage = {
            id: `local-${++localIdCounter}`,
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

    const mediaFolder = useMemo(
        () => chatContents.find((item) => item.name === CONTAINER_MEDIA_FOLDER) ?? null,
        [chatContents],
    );

    const addDriveAttachments = useCallback(
        async (paths: readonly DrivePath[]) => {
            if (!mediaFolder) return;
            const refs = paths.filter((path) => isContainerType(path.type)).map(toAttachmentReference);
            const filesToCopy = paths.filter((path) => !isContainerType(path.type));
            if (refs.length > 0) {
                setPendingDriveAttachments((prev) => [...prev, ...refs]);
            }

            if (filesToCopy.length > 0) {
                const copied = await copyToMediaFolder({ paths: filesToCopy, mediaFolderId: mediaFolder.id }).catch(
                    () => [],
                );
                if (copied.length > 0) {
                    setPendingDriveAttachments((prev) => [...prev, ...copied.map((p) => p.name)]);
                }
            }
        },
        [mediaFolder, copyToMediaFolder],
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

    // Resolves to whether the message took the files. A command that runs here takes nothing, so the composer keeps them.
    const handleSendMessage = useCallback(
        async (rawContent: string, files?: readonly File[]): Promise<boolean> => {
            if (!rawContent.trim() && (!files || files.length === 0) && pendingDriveAttachments.length === 0) {
                return false;
            }

            if (isUnknownCommand(rawContent)) {
                addLocalMessage(`Unknown command: ${rawContent.split(' ')[0]}\nType /help to see available commands.`);
                return false;
            }

            let message: { content: string; type?: 'whisper'; whisperTo?: string } = { content: rawContent };
            const local = getLocalCommand(rawContent);
            switch (local?.kind) {
                case 'error': {
                    addLocalMessage(local.error);
                    return false;
                }
                case 'help': {
                    const lines = COMMANDS_HELP.map((c) => `  ${c.cmd}  —  ${c.desc}`).join('\n');
                    addLocalMessage(`Available commands:\n${lines}`);
                    return false;
                }
                case 'inspect': {
                    addLocalMessage(`inspect:${local.target}`);
                    return false;
                }
                case 'whoami': {
                    if (user?.email) addLocalMessage(`inspect:${user.email}`);
                    return false;
                }
                case 'invite': {
                    const inviteError = validateEmailTarget(local.target, 'Invite');
                    if (inviteError) {
                        addLocalMessage(inviteError);
                        return false;
                    }
                    const result = await inviteToChat.mutateAsync({ email: local.target });
                    addLocalMessage(
                        result.alreadyHasAccess
                            ? `${local.target} already has access.`
                            : `You invited ${local.target}.`,
                    );
                    return false;
                }
                case 'reply': {
                    const target = findLastWhisperFrom();
                    if (!target) {
                        addLocalMessage('No one has whispered to you yet.');
                        return false;
                    }
                    lastWhisperFromRef.current = target;
                    message = { content: local.content, type: 'whisper', whisperTo: target };
                }
            }

            setPendingDriveAttachments([]);
            try {
                const uploaded: string[] = [];
                if (files && files.length > 0) {
                    // The composer is disabled until the folder is known.
                    if (!mediaFolder) throw new Error('A room takes files only once its media folder is known');
                    const results = await Promise.all(
                        files.map((file) => uploadFile.mutateAsync({ parentId: mediaFolder.id, file })),
                    );
                    uploaded.push(...results.map((u) => u.name));
                }
                const attachments = [...pendingDriveAttachments, ...uploaded];
                await postMessage.mutateAsync({
                    ...message,
                    attachments: attachments.length > 0 ? attachments : undefined,
                });
                return true;
            } catch (error) {
                setPendingDriveAttachments((next) => [...pendingDriveAttachments, ...next]);
                throw error;
            }
        },
        [
            mediaFolder,
            pendingDriveAttachments,
            uploadFile.mutateAsync,
            postMessage.mutateAsync,
            inviteToChat.mutateAsync,
            addLocalMessage,
            findLastWhisperFrom,
            user?.email,
        ],
    );

    const allMessages = useMemo(
        () => [...messages, ...localMessages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
        [messages, localMessages],
    );

    const handleDeleteMessage = useCallback(
        (messageId: string) => deleteMessage.mutateAsync(messageId),
        [deleteMessage.mutateAsync],
    );

    const handleEditMessage = useCallback(
        (messageId: string, content: string) => editMessage.mutateAsync({ messageId, content }),
        [editMessage.mutateAsync],
    );

    return {
        messages: allMessages,
        isLoading: messagesQuery.isLoading,
        chatName,
        chatPath,
        roomMembers,
        readOnly,
        // Until the media folder is known, a staged file has nowhere to go.
        disabled: postMessage.isPending || uploadFile.isPending || !mediaFolder,
        currentUserEmail: user?.email ?? '',
        mediaFolderId: mediaFolder?.id ?? null,
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
