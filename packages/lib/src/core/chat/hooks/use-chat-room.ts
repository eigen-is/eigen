import {useCallback, useMemo, useRef, useState} from 'react';
import {useAuth} from '../../auth';
import {useMessages, usePostMessage} from './use-chat';
import {useCheckWritePermission, useFolderContent, usePathInfo, useUpdateACL, useUploadFile} from '../../drive';
import {COMMANDS_HELP, getLocalCommand, isUnknownCommand} from '../commands';
import {validateEmailTarget} from '../../../validation';
import type {ChatMessage, RoomMember} from '../../../types/chat';
import type {DriveACL} from '../../../types/drive';

let localIdCounter = 0;

export function useChatRoom(ownerId: string, mountId: string, chatId: string) {
    const {user} = useAuth();

    const {data: messages = [], isLoading} = useMessages(ownerId, mountId, chatId);
    const postMessage = usePostMessage(ownerId, mountId, chatId);
    const uploadFile = useUploadFile(ownerId, mountId);
    const {data: chatPath} = usePathInfo(ownerId, mountId, chatId);
    const updateACL = useUpdateACL(ownerId, mountId);
    const {data: writePermission} = useCheckWritePermission(ownerId, mountId, chatId);
    const readOnly = writePermission ? !writePermission.canWrite : false;
    const {data: chatContents = []} = useFolderContent(ownerId, mountId, chatId);

    const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
    const lastWhisperFromRef = useRef<string | null>(null);

    const chatName = chatPath?.name?.replace('.eigenchat', '') || 'Chat';

    const roomMembers: RoomMember[] = useMemo(() => {
        if (!chatPath?.acl) return [];
        return chatPath.acl
            .filter(a => a.id && !a.id.startsWith('team_'))
            .map(a => ({email: a.id, displayName: a.id.split('@')[0]}));
    }, [chatPath?.acl]);

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
        setLocalMessages(prev => [...prev, msg]);
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

    const handleSendMessage = useCallback(async (rawContent: string, files?: File[]) => {
        if (!rawContent.trim() && (!files || files.length === 0)) return;

        let attachments: string[] | undefined;
        if (files && files.length > 0 && chatPath) {
            const mediaFolder = chatContents.find(item => item.name === 'media');
            if (mediaFolder) {
                const uploaded = await Promise.all(
                    files.map(file => uploadFile.mutateAsync({parentId: mediaFolder.id, file}))
                );
                attachments = uploaded.filter(Boolean).map(u => u.name);
            }
        }

        if (isUnknownCommand(rawContent)) {
            addLocalMessage(`Unknown command: ${rawContent.split(' ')[0]}\nType /help to see available commands.`);
            return;
        }

        const local = getLocalCommand(rawContent);
        if (local) {
            switch (local.kind) {
                case 'help': {
                    const lines = COMMANDS_HELP.map(c => `  ${c.cmd}  —  ${c.desc}`).join('\n');
                    addLocalMessage(`Available commands:\n${lines}`);
                    return;
                }
                case 'time': {
                    const now = new Date();
                    addLocalMessage(`Local time: ${now.toLocaleString()}\nServer time: ${now.toUTCString()}`);
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
                        attachments
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
                    const currentAcl = chatPath.acl || [];
                    if (currentAcl.some(a => a.id.toLowerCase() === local.target.toLowerCase())) {
                        addLocalMessage(`${local.target} already has access to this room.`);
                        return;
                    }
                    const newAcl: DriveACL[] = [...currentAcl, {id: local.target, read: true, write: true}];
                    await updateACL.mutateAsync({path: chatPath, acl: newAcl});
                    addLocalMessage(`You invited ${local.target} to the room.`);
                    return;
                }
            }
        }

        await postMessage.mutateAsync({content: rawContent, attachments});
    }, [ownerId, mountId, chatId, chatPath, chatContents, uploadFile, postMessage, updateACL, addLocalMessage, findLastWhisperFrom]);

    const allMessages = useMemo(() => {
        return [...messages, ...localMessages].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
    }, [messages, localMessages]);

    const mediaFolderId = chatContents.find(item => item.name === 'media')?.id ?? null;

    return {
        messages: allMessages,
        isLoading,
        chatName,
        chatPath,
        roomMembers,
        readOnly,
        disabled: postMessage.isPending || uploadFile.isPending,
        currentUserId: user?.id || '',
        mediaFolderId,
        handleSendMessage,
    };
}
