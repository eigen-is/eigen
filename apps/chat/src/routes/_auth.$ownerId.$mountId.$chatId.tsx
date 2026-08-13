import { createFileRoute } from '@tanstack/react-router';
import { useChatEditing, useChatRoom } from '@workspace/lib/chat';
import { useCheckPermissions } from '@workspace/lib/drive';
import { parseOwnerId } from '@workspace/lib/types/owner';
import {
    CenteredToolbar,
    Column,
    ColumnLayout,
    DeleteDialog,
    DocumentShareCluster,
    LoadingState,
    RequestAccessView,
    ToolbarTitle,
} from '@workspace/ui';
import { ChatMessageInput, type ChatMessageInputHandle, ChatMessageList } from '@workspace/ui/components/chat';
import { DrivePickerWithUpload } from '@workspace/ui/components/drive';
import { DriveAccessDialog } from '@workspace/ui/components/drive/drive-access-dialog';
import { DriveRenameItem } from '@workspace/ui/components/drive/drive-rename-item';
import { DriveShareSummary } from '@workspace/ui/components/drive/drive-share-summary';
import { UserAvatar } from '@workspace/ui/components/user';
import { useRef, useState } from 'react';

function ChatView() {
    const { ownerId, mountId, chatId } = Route.useParams();
    const chat = useChatRoom(ownerId, mountId, chatId);
    const editing = useChatEditing(chat);

    const { data: permissions, isLoading: permLoading } = useCheckPermissions(ownerId, mountId, chatId);

    const [accessDialogOpen, setAccessDialogOpen] = useState(false);
    const [renameDialogOpen, setRenameDialogOpen] = useState(false);
    const [filePickerOpen, setFilePickerOpen] = useState(false);
    const chatInputRef = useRef<ChatMessageInputHandle>(null);

    if (permLoading) return <LoadingState />;
    if (!permissions?.canRead) {
        return <RequestAccessView ownerId={ownerId} mountId={mountId} pathId={chatId} />;
    }

    const isTeam = parseOwnerId(ownerId).type === 'team';

    const toolbar = (
        <CenteredToolbar
            left={
                chat.chatPath &&
                (isTeam ? (
                    <UserAvatar email={ownerId} size="sm" popover tooltip />
                ) : (
                    <DriveShareSummary
                        path={chat.chatPath}
                        onClick={() => setAccessDialogOpen(true)}
                        showIconOnHover={false}
                    />
                ))
            }
            center={chat.chatPath && <ToolbarTitle>{chat.chatName}</ToolbarTitle>}
            right={
                <div className="flex items-center gap-1">
                    <DocumentShareCluster
                        canWrite={permissions.canWrite}
                        onAccessDialogOpen={() => setAccessDialogOpen(true)}
                        onRename={permissions.canWrite ? () => setRenameDialogOpen(true) : undefined}
                        watchTarget={{ ownerId, mountId, pathId: chatId }}
                    />
                </div>
            }
        />
    );

    return (
        <>
            <ColumnLayout>
                <Column id="messages" width="flex" onBack="sidebar" toolbar={toolbar}>
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
                            onEditMessage={(msg) => editing.setEditingMessageId(msg.id)}
                            onDeleteMessage={editing.setDeleteTarget}
                            editingMessageId={editing.editingMessageId}
                            onSaveEdit={editing.handleSaveEdit}
                            onCancelEdit={editing.endEditing}
                        />
                        <ChatMessageInput
                            ref={chatInputRef}
                            onSend={chat.handleSendMessage}
                            disabled={chat.disabled}
                            readOnly={chat.readOnly}
                            placeholder={`Message ${chat.chatName}`}
                            roomMembers={chat.roomMembers}
                            currentUserEmail={chat.currentUserEmail}
                            messageCount={chat.messages.length + editing.focusTrigger}
                            onKeyDown={editing.onKeyDown}
                            onAttachClick={() => setFilePickerOpen(true)}
                            driveAttachments={chat.driveAttachments}
                            onRemoveDriveAttachment={chat.removeDriveAttachment}
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
                onPickFromDrive={chat.addDriveAttachments}
                onPickFromDevice={(files) => chatInputRef.current?.addFiles(files)}
                multiple
            />
        </>
    );
}

export const Route = createFileRoute('/_auth/$ownerId/$mountId/$chatId')({
    component: ChatView,
});
