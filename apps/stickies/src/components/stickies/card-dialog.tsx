import { useChatEditing, useChatRoom } from '@workspace/lib/chat';
import { useMediaResolver } from '@workspace/lib/drive';
import { ChatMessageInput, ChatMessageList, NoteCardDialog, useCreatedByMeta } from '@workspace/ui';
import { DeleteDialog } from '@workspace/ui/components/layout/delete/delete-dialog';
import { useState } from 'react';
import type * as Y from 'yjs';
import { CardSettingsDialog } from './card-settings-dialog';
import type { CardItem } from './types';

function CardChat({ ownerId, mountId, chatName }: { ownerId: string; mountId: string; chatName: string }) {
    const { resolveChatId } = useMediaResolver();
    const chatId = resolveChatId(chatName);

    if (!chatId) return <div className="px-4 pb-4 text-sm text-muted-foreground">Chat not found.</div>;

    return <CardChatInner ownerId={ownerId} mountId={mountId} chatId={chatId} />;
}

function CardChatInner({ ownerId, mountId, chatId }: { ownerId: string; mountId: string; chatId: string }) {
    const chat = useChatRoom(ownerId, mountId, chatId);
    const editing = useChatEditing(chat);

    return (
        <div className="flex flex-col h-[50vh] overflow-hidden">
            <ChatMessageList
                messages={chat.messages}
                isLoading={chat.isLoading}
                currentUserId={chat.currentUserId}
                ownerId={ownerId}
                mountId={mountId}
                mediaFolderId={chat.mediaFolderId}
                emptyMessage=""
                onEditMessage={(msg) => editing.setEditingMessageId(msg.id)}
                onDeleteMessage={editing.setDeleteTarget}
                editingMessageId={editing.editingMessageId}
                onSaveEdit={editing.handleSaveEdit}
                onCancelEdit={editing.endEditing}
            />
            <ChatMessageInput
                onSend={chat.handleSendMessage}
                disabled={chat.disabled}
                readOnly={chat.readOnly}
                placeholder="Write a comment..."
                roomMembers={chat.roomMembers}
                currentUserEmail={chat.currentUserEmail}
                messageCount={chat.messages.length + editing.focusTrigger}
                onKeyDown={editing.onKeyDown}
            />
            <DeleteDialog
                open={!!editing.deleteTarget}
                onOpenChange={(open) => !open && editing.setDeleteTarget(null)}
                title="Delete Message"
                description="Are you sure you want to delete this message? This cannot be undone."
                onDelete={editing.handleDeleteConfirm}
            />
        </div>
    );
}

type CardDialogProps = {
    isOpen: boolean;
    onClose: () => void;
    card: CardItem | null;
    canWrite?: boolean;
    yjsDoc: Y.Doc | null;
    ownerId: string;
    mountId: string;
    copyLinkUrl?: string;
};

export function CardDialog({
    isOpen,
    onClose,
    card,
    canWrite = true,
    yjsDoc,
    ownerId,
    mountId,
    copyLinkUrl,
}: CardDialogProps) {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const meta = useCreatedByMeta(card?.creator || undefined, card?.createdAt || 0);

    if (!card) return null;

    return (
        <>
            <NoteCardDialog
                open={isOpen}
                onOpenChange={(open) => !open && onClose()}
                title={card.title}
                description={card.description}
                meta={card.creator ? meta : undefined}
                color={card.color}
                canWrite={canWrite}
                onEdit={() => setIsSettingsOpen(true)}
                copyLinkUrl={copyLinkUrl}
            >
                {card.chatName ? (
                    <CardChat ownerId={ownerId} mountId={mountId} chatName={card.chatName} />
                ) : (
                    <div className="px-4 pb-4 text-sm text-muted-foreground">No chat available for this card.</div>
                )}
            </NoteCardDialog>

            {card && canWrite && (
                <CardSettingsDialog
                    key={card.id}
                    isOpen={isSettingsOpen}
                    onClose={() => setIsSettingsOpen(false)}
                    cardId={card.id}
                    cardTitle={card.title}
                    cardDescription={card.description}
                    cardColor={card.color || ''}
                    yjsDoc={yjsDoc}
                />
            )}
        </>
    );
}
