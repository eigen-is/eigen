// The comment thread in a card's dialog: the messages of its chat room, the composer, and the dialog that deletes a
// message. It finds the chat room by name in the document's chat folder. Where the dialog scrolls the card and the
// messages as one, below the card or on a phone, the list doesn't scroll on its own and the composer stays pinned.

import { useChatEditing, useChatRoom } from '@workspace/lib/chat';
import { useMediaResolver } from '@workspace/lib/drive';
import { useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import type { ThreadPlacement } from '../cards/card-dialog-shell';
import type { ChatMessageInputHandle } from '../chat/chat-message-input';
import { ChatMessageInput } from '../chat/chat-message-input';
import { ChatMessageList } from '../chat/chat-message-list';
import { DeleteDialog } from '../delete/delete-dialog';
import { DrivePickerWithUpload } from '../drive/drive-picker-with-upload';
import { LoadingState } from '../layout/app/loading-state';

const FLOW = {
    below: {
        thread: 'h-auto grow',
        list: 'flex-none overflow-visible',
        composer: 'sticky bottom-0 mt-auto bg-background',
    },
    beside: {
        thread: 'h-full max-md:h-auto max-md:grow',
        list: 'max-md:flex-none max-md:overflow-visible',
        composer: 'max-md:sticky max-md:bottom-0 max-md:mt-auto max-md:bg-background',
    },
} satisfies Record<ThreadPlacement, Record<string, string>>;

type CommentThreadProps = {
    ownerId: string;
    mountId: string;
    // The container this comment sits in: its notifications are tagged with that path, not the chat's.
    pathId: string;
    chatName: string;
    placement: ThreadPlacement;
};

export function CommentThread({ ownerId, mountId, pathId, chatName, placement }: CommentThreadProps) {
    const { resolveChatId } = useMediaResolver();
    const chatId = resolveChatId(chatName);

    // A name the listing lacks waits for the listing's refetch, with the loading line the message list shows. If the
    // thread is gone, the card reads deleted and the dialog shows that instead of this thread.
    if (!chatId) {
        return (
            <div className={cn('h-[50vh] min-h-0', FLOW[placement].thread)}>
                <LoadingState />
            </div>
        );
    }

    return (
        <CommentThreadInner
            key={chatId}
            ownerId={ownerId}
            mountId={mountId}
            pathId={pathId}
            chatId={chatId}
            placement={placement}
        />
    );
}

function CommentThreadInner({
    ownerId,
    mountId,
    pathId,
    chatId,
    placement,
}: { chatId: string } & Omit<CommentThreadProps, 'chatName'>) {
    const flow = FLOW[placement];
    const chat = useChatRoom(ownerId, mountId, chatId, pathId);
    const editing = useChatEditing(chat);
    const [filePickerOpen, setFilePickerOpen] = useState(false);
    const inputRef = useRef<ChatMessageInputHandle>(null);

    return (
        // Overflow stays visible, so the input's @-mention list can reach above the thread. min-h-0 lets this flex
        // item shrink below its content. Without it the list never scrolls, and the input ends up below the dialog.
        <div className={cn('flex flex-col h-[50vh] min-h-0', flow.thread)}>
            <ChatMessageList
                messages={chat.messages}
                isLoading={chat.isLoading}
                currentUserEmail={chat.currentUserEmail}
                ownerId={ownerId}
                mountId={mountId}
                mediaFolderId={chat.mediaFolderId}
                emptyMessage=""
                className={cn('flex-1 min-h-0', flow.list)}
                onEditMessage={(msg) => editing.setEditingMessageId(msg.id)}
                onDeleteMessage={editing.setDeleteTarget}
                editingMessageId={editing.editingMessageId}
                onSaveEdit={editing.handleSaveEdit}
                onCancelEdit={editing.endEditing}
            />
            <div className={flow.composer}>
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
            </div>
            <DeleteDialog
                open={!!editing.deleteTarget}
                onOpenChange={(open) => !open && editing.setDeleteTarget(null)}
                title="Delete message"
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
