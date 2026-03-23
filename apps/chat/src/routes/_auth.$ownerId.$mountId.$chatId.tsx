import {createFileRoute} from '@tanstack/react-router'
import {useState} from 'react';
import {useChatRoom} from "@workspace/lib/chat";
import {Column, ColumnLayout} from "@workspace/ui/components/layout/app/column-layout.tsx";
import {ChatMessageInput, ChatMessageList, Toolbar, TooltipButton} from "@workspace/ui";
import {Pencil, UserRoundPlus} from "lucide-react";
import {DriveAccessDialog} from "@workspace/ui/components/layout/drive/drive-access-dialog";
import {DriveRenameItem} from "@workspace/ui/components/layout/drive/drive-rename-item";
import {DriveShareSummary} from "@workspace/ui/components/layout/drive/drive-share-summary";

function ChatView() {
    const {ownerId, mountId, chatId} = Route.useParams();
    const chat = useChatRoom(ownerId, mountId, chatId);

    const [accessDialogOpen, setAccessDialogOpen] = useState(false);
    const [renameDialogOpen, setRenameDialogOpen] = useState(false);

    const toolbar = (
        <Toolbar>
            {chat.chatPath && <DriveShareSummary path={chat.chatPath} onClick={() => setAccessDialogOpen(true)}
                                            showIconOnHover={false}/>}
            <span className="font-semibold text-sm truncate">{chat.chatName}</span>
            <div className="flex items-center gap-1">
                <TooltipButton
                    icon={Pencil}
                    tooltipText="Edit"
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
        </Toolbar>
    );

    return (
        <>
            <ColumnLayout>
                <Column id="messages" width="flex" toolbar={toolbar}>
                    <div className="flex flex-col h-full bg-background">
                        <ChatMessageList
                            key={chatId}
                            messages={chat.messages}
                            isLoading={chat.isLoading}
                            currentUserId={chat.currentUserId}
                            ownerId={ownerId}
                            mountId={mountId}
                            mediaFolderId={chat.mediaFolderId}
                            hasOlderMessages={chat.hasOlderMessages}
                            isFetchingOlderMessages={chat.isFetchingOlderMessages}
                            onLoadMore={chat.fetchOlderMessages}
                        />
                        <ChatMessageInput
                            onSend={chat.handleSendMessage}
                            disabled={chat.disabled}
                            readOnly={chat.readOnly}
                            placeholder={`Message ${chat.chatName}`}
                            roomMembers={chat.roomMembers}
                            messageCount={chat.messages.length}
                        />
                    </div>
                </Column>
            </ColumnLayout>

            <DriveAccessDialog
                open={accessDialogOpen}
                onOpenChange={setAccessDialogOpen}
                path={chat.chatPath ?? null}
            />

            <DriveRenameItem
                path={chat.chatPath ?? null}
                open={renameDialogOpen}
                onOpenChange={setRenameDialogOpen}
            />
        </>
    );
}

export const Route = createFileRoute('/_auth/$ownerId/$mountId/$chatId')({
    component: ChatView,
})
