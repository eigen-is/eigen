import { useNavigate } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import { useChats, useUnreadChatIds } from '@workspace/lib/chat';
import { useDriveAccess } from '@workspace/lib/drive';
import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { EigenLoader, UnreadDot, UserAvatar } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { DriveCreateEigenDoc } from '@workspace/ui/components/layout/drive/drive-create-eigendoc';
import { SidebarHeader } from '@workspace/ui/components/layout/sidebar/sidebar-header';
import { SidebarItem } from '@workspace/ui/components/layout/sidebar/sidebar-item';
import { SidebarSection } from '@workspace/ui/components/layout/sidebar/sidebar-section';
import { Separator } from '@workspace/ui/components/separator';
import { cn } from '@workspace/ui/lib/utils';
import { MessageSquare, Plus } from 'lucide-react';
import { useCallback, useState } from 'react';

const MAX_AVATARS = 4;

type ChatSidebarProps = {
    condensed?: boolean;
    isMobile?: boolean;
    onClose?: () => void;
    ownerId: string;
    mountId: string;
    rootPath: DrivePath | null;
};

type ChatItemProps = {
    chat: DrivePath;
    condensed: boolean;
    hasUnread?: boolean;
};

function ChatItem({ chat, condensed, hasUnread }: ChatItemProps) {
    // Empty preloadedBreadcrumb skips the (irrelevant) inherited-access fetch — sidebar
    // only cares about owner + direct ACL, never ancestor folders.
    const { allEntries } = useDriveAccess(chat, undefined, []);
    const label = (chat.name || 'Unnamed chat').replace(/\.eigenchat$/, '');
    const to = `/${chat.ownerId}/${chat.mountId}/${chat.id}`;

    return (
        <SidebarItem
            icon={
                <div className="relative">
                    <MessageSquare className="h-4 w-4" />
                    {hasUnread && <UnreadDot />}
                </div>
            }
            label={label}
            to={to}
            condensed={condensed}
        >
            {!condensed && (
                <div className="flex items-center ml-auto">
                    {allEntries.slice(0, MAX_AVATARS).map((entry, i) => (
                        <UserAvatar key={entry.id} email={entry.id} className={cn('h-4 w-4', i > 0 && '-ml-2')} />
                    ))}
                </div>
            )}
        </SidebarItem>
    );
}

type TeamChatItemsProps = {
    teamId: string;
    condensed: boolean;
    unreadChatIds: Set<string>;
};

function TeamChatItems({ teamId, condensed, unreadChatIds }: TeamChatItemsProps) {
    const { data: chats } = useChats(teamOwnerId(teamId));
    if (!chats || chats.length === 0) return null;
    return (
        <>
            {chats.map((chat) => (
                <ChatItem key={chat.id} chat={chat} condensed={condensed} hasUnread={unreadChatIds.has(chat.id)} />
            ))}
        </>
    );
}

export function ChatSidebar({
    condensed = false,
    isMobile = false,
    onClose,
    ownerId,
    mountId,
    rootPath,
}: ChatSidebarProps) {
    const { user } = useAuth();
    const unreadChatIds = useUnreadChatIds(user?.id ?? '');
    const { data: chats, isLoading } = useChats(ownerId);
    const [createChatOpen, setCreateChatOpen] = useState(false);
    const navigate = useNavigate();

    const { data: myTeams } = useMyTeams();

    const handleAfterCreate = useCallback(
        (newPath: DrivePath) => {
            navigate({
                to: '/$ownerId/$mountId/$chatId',
                params: { ownerId: newPath.ownerId, mountId: newPath.mountId, chatId: newPath.id },
            });
        },
        [navigate],
    );

    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
            {isMobile && <SidebarHeader appName="chat" onClose={onClose} />}

            <div className="px-3 py-2">
                <Button
                    variant="default"
                    size={condensed ? 'icon' : 'default'}
                    className={`${condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}`}
                    onClick={() => setCreateChatOpen(true)}
                >
                    <Plus className="h-4 w-4" />
                    {!condensed && <span>New chat</span>}
                </Button>
            </div>

            {isLoading || !chats ? (
                <div className="flex justify-center py-4">
                    <EigenLoader />
                </div>
            ) : (
                <SidebarSection condensed={condensed}>
                    {chats.length === 0 ? (
                        <div className="px-3 py-2 text-xs text-muted-foreground">No chats yet</div>
                    ) : (
                        chats.map((chat) => (
                            <ChatItem
                                key={chat.id}
                                chat={chat}
                                condensed={condensed}
                                hasUnread={unreadChatIds.has(chat.id)}
                            />
                        ))
                    )}
                </SidebarSection>
            )}

            {myTeams && myTeams.length > 0 && (
                <>
                    <Separator />
                    <SidebarSection condensed={condensed} title={condensed ? undefined : 'Team Chats'}>
                        {myTeams.map((team) => (
                            <TeamChatItems
                                key={team.id}
                                teamId={team.id}
                                condensed={condensed}
                                unreadChatIds={unreadChatIds}
                            />
                        ))}
                    </SidebarSection>
                </>
            )}

            <DriveCreateEigenDoc
                open={createChatOpen}
                onOpenChange={setCreateChatOpen}
                type="chat"
                defaultOwnerId={ownerId}
                defaultFolderId={rootPath?.id}
                defaultMountId={rootPath?.mountId ?? mountId}
                openInNewTab={false}
                onAfterCreate={handleAfterCreate}
            />
        </div>
    );
}
