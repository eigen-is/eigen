import {createFileRoute} from '@tanstack/react-router'
import {useState} from 'react';
import {useAuth} from "@workspace/lib/auth";
import {useMessages, usePostMessage} from "@workspace/lib/chat";
import {usePathInfo, useUploadFile} from "@workspace/lib/drive";
import {ColumnLayout, Column} from "@workspace/ui/components/layout/column-layout";
import {MessageList} from "../components/chat/message-list";
import {MessageInput} from "../components/chat/message-input";
import {TooltipButton} from "@workspace/ui";
import {Pencil, UserRoundPlus} from "lucide-react";
import {DriveAccessDialog} from "@workspace/ui/components/layout/drive/drive-access-dialog";
import {DriveRenameItem} from "@workspace/ui/components/layout/drive/drive-rename-item";
import type {DrivePath} from "@workspace/lib/types/drive";

function ChatView() {
    const {user} = useAuth();
    const {ownerId, mountId, chatId} = Route.useParams();

    const {data: messages = [], isLoading: messagesLoading} = useMessages(ownerId, mountId, chatId);
    const postMessage = usePostMessage(ownerId, mountId, chatId);
    const uploadFile = useUploadFile(ownerId, mountId);
    const {data: chatPath} = usePathInfo(ownerId, mountId, chatId);

    const [accessDialogOpen, setAccessDialogOpen] = useState(false);
    const [renameDialogOpen, setRenameDialogOpen] = useState(false);

    const chatName = chatPath?.name?.replace('.eigenchat', '') || 'Chat';

    const handleSendMessage = async (content: string, files?: File[]) => {
        if (!content.trim() && (!files || files.length === 0)) return;

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

        await postMessage.mutateAsync({content: content || '', attachments});
    };

    const toolbar = (
        <div className="flex items-center justify-between w-full">
            <span className="font-semibold text-sm truncate">{chatName}</span>
            <div className="flex items-center gap-1">
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
                            messages={messages}
                            isLoading={messagesLoading}
                            currentUserId={user?.id || ''}
                            ownerId={ownerId}
                            mountId={mountId}
                        />
                        <MessageInput
                            onSend={handleSendMessage}
                            disabled={postMessage.isPending || uploadFile.isPending}
                            chatName={chatName}
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
