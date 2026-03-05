import {createFileRoute} from '@tanstack/react-router'
import {useState} from 'react';
import {useChatRoom} from "@workspace/lib/chat";
import {Column, ColumnLayout} from "@workspace/ui/components/layout/app/column-layout.tsx";
import {ChatMessageInput, ChatMessageList, Toolbar, TooltipButton} from "@workspace/ui";
import {Edit, UserRoundPlus} from "lucide-react";
import {DriveAccessDialog} from "@workspace/ui/components/layout/drive/drive-access-dialog";
import {DriveRenameItem} from "@workspace/ui/components/layout/drive/drive-rename-item";
import {DriveShareSummary} from "@workspace/ui/components/layout/drive/drive-share-summary";
import type {DrivePath} from "@workspace/lib/types/drive";

function ChatView() {
    const {ownerId, mountId, chatId} = Route.useParams();
    const chat = useChatRoom(ownerId, mountId, chatId);

    const [accessDialogOpen, setAccessDialogOpen] = useState(false);
    const [renameDialogOpen, setRenameDialogOpen] = useState(false);

    const toolbar = (
        <Toolbar>
            {chat.chatPath && <DriveShareSummary path={chat.chatPath as DrivePath} onClick={() => setAccessDialogOpen(true)}
                                            showIconOnHover={false}/>}
            <span className="font-semibold text-sm truncate">{chat.chatName}</span>
            <div className="flex items-center gap-1">
                <TooltipButton
                    icon={Edit}
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
                            messages={chat.messages}
                            isLoading={chat.isLoading}
                            currentUserId={chat.currentUserId}
                            ownerId={ownerId}
                            mountId={mountId}
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
                path={chat.chatPath as DrivePath || null}
            />

            <DriveRenameItem
                path={chat.chatPath as DrivePath || null}
                open={renameDialogOpen}
                onOpenChange={setRenameDialogOpen}
            />
        </>
    );
}

export const Route = createFileRoute('/_auth/$ownerId/$mountId/$chatId')({
    component: ChatView,
})
