import {createFileRoute} from '@tanstack/react-router'
import {useCallback, useMemo, useRef, useState} from 'react';
import {useAuth} from "@workspace/lib/auth";
import {useMessages, usePostMessage} from "@workspace/lib/chat";
import {usePathInfo, useUploadFile, useUpdateACL, useCheckWritePermission} from "@workspace/lib/drive";
import {ColumnLayout, Column} from "@workspace/ui/components/layout/column-layout";
import {MessageList} from "../components/chat/message-list";
import {MessageInput} from "../components/chat/message-input";
import {TooltipButton} from "@workspace/ui";
import {Pencil, UserRoundPlus} from "lucide-react";
import {DriveAccessDialog} from "@workspace/ui/components/layout/drive/drive-access-dialog";
import {DriveRenameItem} from "@workspace/ui/components/layout/drive/drive-rename-item";
import {DriveShareSummary} from "@workspace/ui/components/layout/drive/drive-share-summary";
import type {DrivePath, DriveACL} from "@workspace/lib/types/drive";
import type {ChatMessage} from "@workspace/lib/types/chat";
import type {RoomMember} from "../components/chat/player-suggest";
import {getLocalCommand, COMMANDS_HELP, isUnknownCommand, validateEmailTarget} from "../lib/commands";
import {toast} from "sonner";

let localIdCounter = 0;

function ChatView() {
    const {user} = useAuth();
    const {ownerId, mountId, chatId} = Route.useParams();

    const {data: messages = [], isLoading: messagesLoading} = useMessages(ownerId, mountId, chatId);
    const postMessage = usePostMessage(ownerId, mountId, chatId);
    const uploadFile = useUploadFile(ownerId, mountId);
    const {data: chatPath} = usePathInfo(ownerId, mountId, chatId);
    const updateACL = useUpdateACL(ownerId);
    const {data: writePermission} = useCheckWritePermission(ownerId, mountId, chatId);
    const readOnly = writePermission ? !writePermission.canWrite : false;

    const [accessDialogOpen, setAccessDialogOpen] = useState(false);
    const [renameDialogOpen, setRenameDialogOpen] = useState(false);
    const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
    const lastWhisperFromRef = useRef<string | null>(null);

    const chatName = chatPath?.name?.replace('.eigenchat', '') || 'Chat';

    const roomMembers: RoomMember[] = useMemo(() => {
        if (!chatPath?.acl) return [];
        return chatPath.acl
            .filter(a => a.email)
            .map(a => ({email: a.email, displayName: a.email.split('@')[0]}));
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

    const handleSendMessage = async (rawContent: string, files?: File[]) => {
        if (!rawContent.trim() && (!files || files.length === 0)) return;

        let attachments: string[] | undefined;
        if (files && files.length > 0 && chatPath) {
            const mediaFolder = await getMediaFolderId(ownerId, mountId, chatId);
            if (mediaFolder) {
                const uploaded = await Promise.all(
                    files.map(file => uploadFile.mutateAsync({parentId: mediaFolder, file}))
                );
                attachments = uploaded.filter(Boolean).map(u => (u as DrivePath).id);
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
                    await postMessage.mutateAsync({content: local.content, type: 'whisper', whisperTo: target, attachments});
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
                    if (currentAcl.some(a => a.email.toLowerCase() === local.target.toLowerCase())) {
                        addLocalMessage(`${local.target} already has access to this room.`);
                        return;
                    }
                    const newAcl: DriveACL[] = [...currentAcl, {email: local.target, read: true, write: true}];
                    try {
                        await updateACL.mutateAsync({path: chatPath as DrivePath, acl: newAcl});
                        addLocalMessage(`You invited ${local.target} to the room.`);
                    } catch {
                        toast.error(`Failed to invite ${local.target}`);
                    }
                    return;
                }
            }
        }

        await postMessage.mutateAsync({content: rawContent, attachments});
    };

    const allMessages = useMemo(() => {
        return [...messages, ...localMessages].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
    }, [messages, localMessages]);

    const toolbar = (
        <div className="flex items-center justify-between w-full">
            <span className="font-semibold text-sm truncate">{chatName}</span>
            <div className="flex items-center gap-2">
                {chatPath && <DriveShareSummary path={chatPath as DrivePath} onClick={() => setAccessDialogOpen(true)} showIconOnHover={false}/>}
                <TooltipButton
                    icon={Pencil}
                    tooltipText="Rename"
                    variant="ghost"
                    onClick={() => setRenameDialogOpen(true)}
                />
                <TooltipButton
                    icon={UserRoundPlus}
                    tooltipText="Share"
                    variant="ghost"
                    onClick={() => setAccessDialogOpen(true)}
                />
            </div>
        </div>
    );

    return (
        <>
            <ColumnLayout>
                <Column id="messages" width="flex" toolbar={toolbar}>
                    <div className="flex flex-col h-full bg-background">
                        <MessageList
                            messages={allMessages}
                            isLoading={messagesLoading}
                            currentUserId={user?.id || ''}
                            ownerId={ownerId}
                            mountId={mountId}
                        />
                        <MessageInput
                            onSend={handleSendMessage}
                            disabled={postMessage.isPending || uploadFile.isPending}
                            readOnly={readOnly}
                            chatName={chatName}
                            roomMembers={roomMembers}
                            messageCount={allMessages.length}
                        />
                    </div>
                </Column>
            </ColumnLayout>

            <DriveAccessDialog
                open={accessDialogOpen}
                onOpenChange={setAccessDialogOpen}
                path={chatPath as DrivePath || null}
            />

            <DriveRenameItem
                path={chatPath as DrivePath || null}
                open={renameDialogOpen}
                onOpenChange={setRenameDialogOpen}
            />
        </>
    );
}

async function getMediaFolderId(ownerId: string, mountId: string, chatId: string): Promise<string | null> {
    const {driveApi} = await import("@workspace/lib/api");
    const response = await driveApi({ownerId})({mountId}).folder({pathId: chatId}).get();
    const contents = (response.data || []) as DrivePath[];
    const media = contents.find(item => item.name === 'media');
    return media?.id || null;
}

export const Route = createFileRoute('/_auth/$ownerId/$mountId/$chatId')({
    component: ChatView,
})
