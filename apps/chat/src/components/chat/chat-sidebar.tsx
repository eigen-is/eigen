import { useNavigate } from '@tanstack/react-router';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { useChats, useTeamsHaveChats, useUnreadChatIds } from '@workspace/lib/chat';
import { useDriveAccess } from '@workspace/lib/drive';
import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import { EigenLoader, UnreadDot, UserAvatar } from '@workspace/ui';
import { DriveCreateEigenDoc } from '@workspace/ui/components/layout/drive/drive-create-eigendoc';
import { SidebarHeader } from '@workspace/ui/components/layout/sidebar/sidebar-header';
import { SidebarItem } from '@workspace/ui/components/layout/sidebar/sidebar-item';
import { SidebarPrimaryButton } from '@workspace/ui/components/layout/sidebar/sidebar-primary-button';
import { SidebarSection } from '@workspace/ui/components/layout/sidebar/sidebar-section';
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
    const label = stripEigenExtension(chat.name || 'Unnamed chat');
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
    const isGuest = useIsGuest();
    const unreadChatIds = useUnreadChatIds(user?.id ?? '');
    const { data: chats, isLoading } = useChats(ownerId);
    const [createChatOpen, setCreateChatOpen] = useState(false);
    const navigate = useNavigate();

    const { data: myTeams } = useMyTeams();
    const hasAnyTeamChats = useTeamsHaveChats((myTeams ?? []).map((t) => t.id));

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

            <div className="flex flex-1 flex-col app-gutter">
                {!isGuest && (
                    <SidebarPrimaryButton
                        icon={Plus}
                        label="New chat"
                        condensed={condensed}
                        onClick={() => setCreateChatOpen(true)}
                    />
                )}

                {isLoading || !chats ? (
                    <div className="flex justify-center py-4">
                        <EigenLoader />
                    </div>
                ) : (
                    chats.length > 0 && (
                        <SidebarSection condensed={condensed} className="px-0">
                            {chats.map((chat) => (
                                <ChatItem
                                    key={chat.id}
                                    chat={chat}
                                    condensed={condensed}
                                    hasUnread={unreadChatIds.has(chat.id)}
                                />
                            ))}
                        </SidebarSection>
                    )
                )}

                {hasAnyTeamChats && (
                    <SidebarSection condensed={condensed} className="px-0" title={condensed ? undefined : 'Team Chats'}>
                        {(myTeams ?? []).map((team) => (
                            <TeamChatItems
                                key={team.id}
                                teamId={team.id}
                                condensed={condensed}
                                unreadChatIds={unreadChatIds}
                            />
                        ))}
                    </SidebarSection>
                )}
            </div>

            {!isGuest && (
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
            )}
        </div>
    );
}
