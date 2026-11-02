// Everything a chat room view needs, in one hook: the messages in order, the members, the attachments
// waiting to be sent, and the send handler, which also runs slash commands such as /help or /invite.
// A chat file and a comment thread on a document both render through it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
export function useChatRoom(ownerId: string, mountId: string, chatId: string, containerPathId?: string) {
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

    useEffect(() => {
        setLocalMessages([]);
        setPendingDriveAttachments([]);
        lastWhisperFromRef.current = null;
    }, [chatId]);

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

    const mediaFolder = useMemo(() => chatContents.find((item) => item.name === 'media') ?? null, [chatContents]);

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

    const handleSendMessage = useCallback(
        async (rawContent: string, files?: readonly File[]) => {
            if (!rawContent.trim() && (!files || files.length === 0) && pendingDriveAttachments.length === 0) return;

            let attachments: ChatAttachment[] | undefined;

            if (pendingDriveAttachments.length > 0) {
                attachments = [...pendingDriveAttachments];
                setPendingDriveAttachments([]);
            }

            if (files && files.length > 0 && chatPath && mediaFolder) {
                const uploaded = await Promise.all(
                    files.map((file) => uploadFile.mutateAsync({ parentId: mediaFolder.id, file })),
                );
                attachments = [...(attachments ?? []), ...uploaded.map((u) => u.name)];
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
                    case 'whoami': {
                        if (user?.email) addLocalMessage(`inspect:${user.email}`);
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
                        const result = await inviteToChat.mutateAsync({ email: local.target });
                        if (result?.alreadyHasAccess) {
                            addLocalMessage(`${local.target} already has access.`);
                        } else {
                            addLocalMessage(`You invited ${local.target}.`);
                        }
                        return;
                    }
                }
            }

            await postMessage.mutateAsync({ content: rawContent, attachments });
        },
        [
            chatPath,
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

    const mediaFolderId = mediaFolder?.id ?? null;

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
        disabled: postMessage.isPending || uploadFile.isPending,
        currentUserEmail: user?.email ?? '',
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
