import { useChatEditing, useChatRoom } from '@workspace/lib/chat';
import { useMediaResolver } from '@workspace/lib/drive';
import { cn } from '../../../lib/utils';
import { ChatMessageInput } from '../chat/chat-message-input';
import { ChatMessageList } from '../chat/chat-message-list';
import { DeleteDialog } from '../delete/delete-dialog';

type CommentThreadProps = {
    ownerId: string;
    mountId: string;
    chatName: string;
    className?: string;
};

function CommentThreadInner({
    ownerId,
    mountId,
    chatId,
    className,
}: { chatId: string } & Omit<CommentThreadProps, 'chatName'>) {
    const chat = useChatRoom(ownerId, mountId, chatId);
    const editing = useChatEditing(chat);

    return (
        <div className={cn('flex flex-col flex-1 min-h-0 overflow-hidden', className)}>
            <ChatMessageList
                messages={chat.messages}
                isLoading={chat.isLoading}
                currentUserId={chat.currentUserId}
                ownerId={ownerId}
                mountId={mountId}
                mediaFolderId={chat.mediaFolderId}
                emptyMessage=""
                className="flex-1 min-h-0"
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
                placeholder="Reply..."
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

export function CommentThread({ ownerId, mountId, chatName, className }: CommentThreadProps) {
    const { resolveChatId } = useMediaResolver();
    const chatId = resolveChatId(chatName);

    if (!chatId) {
        return <div className={cn('px-4 pb-4 text-sm text-muted-foreground', className)}>Comment not found.</div>;
    }

    return <CommentThreadInner ownerId={ownerId} mountId={mountId} chatId={chatId} className={className} />;
}
