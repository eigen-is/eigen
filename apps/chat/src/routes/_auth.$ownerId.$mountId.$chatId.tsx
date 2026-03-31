import { createFileRoute } from '@tanstack/react-router';
import { useChatRoom } from '@workspace/lib/chat';
import type { ChatMessage } from '@workspace/lib/types/chat';
import { ChatMessageInput, ChatMessageList, Toolbar, TooltipButton } from '@workspace/ui';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout.tsx';
import { DeleteDialog } from '@workspace/ui/components/layout/delete/delete-dialog';
import { DriveAccessDialog } from '@workspace/ui/components/layout/drive/drive-access-dialog';
import { DriveRenameItem } from '@workspace/ui/components/layout/drive/drive-rename-item';
import { DriveShareSummary } from '@workspace/ui/components/layout/drive/drive-share-summary';
import { Pencil, UserRoundPlus } from 'lucide-react';
import { useState } from 'react';

function ChatView() {
    const { ownerId, mountId, chatId } = Route.useParams();
    const chat = useChatRoom(ownerId, mountId, chatId);

    const [accessDialogOpen, setAccessDialogOpen] = useState(false);
    const [renameDialogOpen, setRenameDialogOpen] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<ChatMessage | null>(null);
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
    const [focusTrigger, setFocusTrigger] = useState(0);

    const handleDeleteConfirm = async () => {
        if (!deleteTarget) return;
        await chat.handleDeleteMessage(deleteTarget.id);
        setDeleteTarget(null);
    };

    const endEditing = () => {
        setEditingMessageId(null);
        setFocusTrigger((n) => n + 1);
    };

    const handleSaveEdit = async (messageId: string, content: string) => {
        await chat.handleEditMessage(messageId, content);
        endEditing();
    };

    const toolbar = (
        <Toolbar>
            {chat.chatPath && (
                <DriveShareSummary
                    path={chat.chatPath}
                    onClick={() => setAccessDialogOpen(true)}
                    showIconOnHover={false}
                />
            )}
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
                            onEditMessage={(msg) => setEditingMessageId(msg.id)}
                            onDeleteMessage={setDeleteTarget}
                            editingMessageId={editingMessageId}
                            onSaveEdit={handleSaveEdit}
                            onCancelEdit={endEditing}
                        />
                        <ChatMessageInput
                            onSend={chat.handleSendMessage}
                            disabled={chat.disabled}
                            readOnly={chat.readOnly}
                            placeholder={`Message ${chat.chatName}`}
                            roomMembers={chat.roomMembers}
                            currentUserEmail={chat.currentUserEmail}
                            messageCount={chat.messages.length + focusTrigger}
                            onKeyDown={(e, content) => {
                                if (e.key === 'ArrowUp' && !content.trim()) {
                                    const lastOwn = [...chat.messages]
                                        .reverse()
                                        .find(
                                            (m) =>
                                                m.authorId === chat.currentUserId &&
                                                !m.deletedAt &&
                                                m.type === 'message',
                                        );
                                    if (lastOwn) {
                                        e.preventDefault();
                                        setEditingMessageId(lastOwn.id);
                                        return true;
                                    }
                                }
                                return undefined;
                            }}
                        />
                    </div>
                </Column>
            </ColumnLayout>

            <DriveAccessDialog
                open={accessDialogOpen}
                onOpenChange={setAccessDialogOpen}
                path={chat.chatPath ?? null}
            />

            <DriveRenameItem path={chat.chatPath ?? null} open={renameDialogOpen} onOpenChange={setRenameDialogOpen} />

            <DeleteDialog
                open={!!deleteTarget}
                onOpenChange={(open) => !open && setDeleteTarget(null)}
                title="Delete Message"
                description="Are you sure you want to delete this message? This cannot be undone."
                onDelete={handleDeleteConfirm}
            />
        </>
    );
}

export const Route = createFileRoute('/_auth/$ownerId/$mountId/$chatId')({
    component: ChatView,
});
