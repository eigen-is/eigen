import { useChatEditing, useChatRoom } from '@workspace/lib/chat';
import { useMediaResolver } from '@workspace/lib/drive';
import { useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { ChatMessageInput, type ChatMessageInputHandle } from '../chat/chat-message-input';
import { ChatMessageList } from '../chat/chat-message-list';
import { DeleteDialog } from '../delete/delete-dialog';
import { DrivePickerWithUpload } from '../drive/drive-picker-with-upload';

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
    const [filePickerOpen, setFilePickerOpen] = useState(false);
    const inputRef = useRef<ChatMessageInputHandle>(null);

    return (
        // Overflow stays visible so the input's @-mention suggest can extend above the thread.
        // min-h-0 keeps the sizing side effect overflow-hidden used to provide: without it this
        // flex item refuses to shrink below its content, so the list never scrolls and the input
        // gets pushed below the dialog.
        <div className={cn('flex flex-col h-[50vh] min-h-0', className)}>
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
                ref={inputRef}
                onSend={chat.handleSendMessage}
                disabled={chat.disabled}
                readOnly={chat.readOnly}
                placeholder="Reply..."
                roomMembers={chat.roomMembers}
                currentUserEmail={chat.currentUserEmail}
                messageCount={chat.messages.length + editing.focusTrigger}
                onKeyDown={editing.onKeyDown}
                onAttachClick={() => setFilePickerOpen(true)}
                driveAttachments={chat.driveAttachments}
                onRemoveDriveAttachment={chat.removeDriveAttachment}
            />
            <DeleteDialog
                open={!!editing.deleteTarget}
                onOpenChange={(open) => !open && editing.setDeleteTarget(null)}
                title="Delete Message"
                description="Are you sure you want to delete this message? This cannot be undone."
                onDelete={editing.handleDeleteConfirm}
            />
            <DrivePickerWithUpload
                open={filePickerOpen}
                onOpenChange={setFilePickerOpen}
                title="Attach file"
                multiSelect
                multiple
                onPickFromDrive={chat.addDriveAttachments}
                onPickFromDevice={(files) => inputRef.current?.addFiles(files)}
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
