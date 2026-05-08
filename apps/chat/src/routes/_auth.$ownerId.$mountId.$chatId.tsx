import { createFileRoute } from '@tanstack/react-router';
import { useChatEditing, useChatRoom } from '@workspace/lib/chat';
import { useCheckPermissions } from '@workspace/lib/drive';
import { useMyTeams } from '@workspace/lib/home';
import { useTeamMembers } from '@workspace/lib/team';
import { parseOwnerId } from '@workspace/lib/types/owner';
import {
    ChatMessageInput,
    type ChatMessageInputHandle,
    ChatMessageList,
    LoadingState,
    RequestAccessView,
    Toolbar,
    TooltipButton,
    UserAvatar,
} from '@workspace/ui';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout.tsx';
import { CollapsibleUserList } from '@workspace/ui/components/layout/collapsible-user-list';
import { DeleteDialog } from '@workspace/ui/components/layout/delete/delete-dialog';
import { DriveAccessDialog } from '@workspace/ui/components/layout/drive/drive-access-dialog';
import { DrivePickerWithUpload } from '@workspace/ui/components/layout/drive/drive-picker-with-upload';
import { DriveRenameItem } from '@workspace/ui/components/layout/drive/drive-rename-item';
import { DriveShareSummary } from '@workspace/ui/components/layout/drive/drive-share-summary';
import { UserItem } from '@workspace/ui/components/layout/user-item';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { Pencil, UserRoundPlus } from 'lucide-react';
import { useRef, useState } from 'react';

function TeamAvatarPopover({ ownerId }: { ownerId: string }) {
    const teamId = parseOwnerId(ownerId).id;
    const { data: teams } = useMyTeams();
    const team = teams?.find((t) => t.id === teamId);
    const { data: members = [] } = useTeamMembers(teamId);

    return (
        <Popover>
            <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                        <button
                            type="button"
                            aria-label={team?.name ? `${team.name} members` : 'Team members'}
                            className="rounded-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <UserAvatar email={ownerId} size="sm" />
                        </button>
                    </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>{team?.name ?? 'Team'}</TooltipContent>
            </Tooltip>
            <PopoverContent align="start" className="w-80 p-2 max-h-[70vh] overflow-y-auto">
                <CollapsibleUserList
                    title={team?.name ?? 'Team'}
                    count={members.length}
                    collapseThreshold={Number.POSITIVE_INFINITY}
                    summaryLines={[`${members.length} ${members.length === 1 ? 'member' : 'members'}`]}
                >
                    {members.map((m) => (
                        <UserItem key={m.userId} userId={m.userId} name={m.name} email={m.email} />
                    ))}
                </CollapsibleUserList>
            </PopoverContent>
        </Popover>
    );
}

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
        <Toolbar>
            {chat.chatPath &&
                (isTeam ? (
                    <TeamAvatarPopover ownerId={ownerId} />
                ) : (
                    <DriveShareSummary
                        path={chat.chatPath}
                        onClick={() => setAccessDialogOpen(true)}
                        showIconOnHover={false}
                    />
                ))}
            {chat.chatPath && <span className="font-semibold text-sm truncate">{chat.chatName}</span>}
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
