import { useNavigate } from '@tanstack/react-router';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { useChatSections, useUnreadChatIds } from '@workspace/lib/chat';
import { useDriveAccess } from '@workspace/lib/drive';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import { UnreadDot } from '@workspace/ui';
import { ChatCreateWizard } from '@workspace/ui/components/chat/chat-create-wizard';
import { StorageUsage } from '@workspace/ui/components/home';
import { SidebarBody } from '@workspace/ui/components/layout/sidebar/sidebar-body';
import { SidebarItem } from '@workspace/ui/components/layout/sidebar/sidebar-item';
import { SidebarPrimaryButton } from '@workspace/ui/components/layout/sidebar/sidebar-primary-button';
import { SidebarSection } from '@workspace/ui/components/layout/sidebar/sidebar-section';
import { UserAvatar } from '@workspace/ui/components/user';
import { cn } from '@workspace/ui/lib/utils';
import { MessageSquare, Plus } from 'lucide-react';
import { useState } from 'react';

const MAX_AVATARS = 4;

type ChatSidebarProps = {
    condensed?: boolean;
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

export function ChatSidebar({ condensed = false }: ChatSidebarProps) {
    const navigate = useNavigate();
    const { user } = useAuth();
    const isGuest = useIsGuest();
    const unreadChatIds = useUnreadChatIds(user?.id ?? '');
    const { personal, teams, isLoading } = useChatSections();
    const [createChatOpen, setCreateChatOpen] = useState(false);

    // Team chats render under a single "Team Chats" heading, flattened in useMyTeams order.
    const teamChats = teams.flatMap((t) => t.chats);

    return (
        <>
            <SidebarBody>
                {!isGuest && (
                    <SidebarPrimaryButton
                        icon={Plus}
                        label="New chat"
                        condensed={condensed}
                        onClick={() => setCreateChatOpen(true)}
                    />
                )}

                {isLoading ? (
                    <SidebarSection condensed={condensed} loading />
                ) : (
                    personal.length > 0 && (
                        <SidebarSection condensed={condensed}>
                            {personal.map((chat) => (
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

                {teamChats.length > 0 && (
                    <SidebarSection condensed={condensed} title={condensed ? undefined : 'Team Chats'}>
                        {teamChats.map((chat) => (
                            <ChatItem
                                key={chat.id}
                                chat={chat}
                                condensed={condensed}
                                hasUnread={unreadChatIds.has(chat.id)}
                            />
                        ))}
                    </SidebarSection>
                )}

                {/* Guests manage no storage — drive's guest sidebar omits this too. */}
                {!isGuest && <StorageUsage className="mt-auto" condensed={condensed} />}
            </SidebarBody>

            {!isGuest && (
                <ChatCreateWizard
                    open={createChatOpen}
                    onOpenChange={setCreateChatOpen}
                    onNavigate={(path) =>
                        navigate({
                            to: '/$ownerId/$mountId/$chatId',
                            params: { ownerId: path.ownerId, mountId: path.mountId, chatId: path.id },
                        })
                    }
                />
            )}
        </>
    );
}
