import { useNavigate } from '@tanstack/react-router';
import { useChats, useCreateChat } from '@workspace/lib/chat';
import { usePeopleTeams } from '@workspace/lib/people';
import { usePublicConfig } from '@workspace/lib/public';
import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { EigenLoader } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { DriveCreateItemDialog } from '@workspace/ui/components/layout/drive/drive-create-folder-item';
import { SidebarHeader } from '@workspace/ui/components/layout/sidebar/sidebar-header';
import { SidebarItem } from '@workspace/ui/components/layout/sidebar/sidebar-item';
import { SidebarSection } from '@workspace/ui/components/layout/sidebar/sidebar-section';
import { Separator } from '@workspace/ui/components/separator';
import { MessageSquare, Plus } from 'lucide-react';
import { useState } from 'react';

type ChatSidebarProps = {
    condensed?: boolean;
    isMobile?: boolean;
    onClose?: () => void;
    ownerId: string;
    mountId: string;
    rootPath: DrivePath | null;
};

function ChatItem({ chat, condensed }: { chat: DrivePath; condensed: boolean }) {
    return (
        <SidebarItem
            icon={<MessageSquare className="h-4 w-4" />}
            label={(chat.name || 'Unnamed chat').replace(/\.eigenchat$/, '')}
            to={`/${chat.ownerId}/${chat.mountId}/${chat.id}`}
            condensed={condensed}
        />
    );
}

function TeamChatItems({ teamId, condensed }: { teamId: string; condensed: boolean }) {
    const { data: chats } = useChats(teamOwnerId(teamId));
    if (!chats || chats.length === 0) return null;
    return (
        <>
            {chats.map((chat) => (
                <ChatItem key={chat.id} chat={chat} condensed={condensed} />
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
    const { data: chats, isLoading } = useChats(ownerId);
    const [createChatOpen, setCreateChatOpen] = useState(false);
    const createChatMutation = useCreateChat(ownerId, mountId);
    const navigate = useNavigate();

    const { data: config } = usePublicConfig();
    const { data: teams } = usePeopleTeams(config?.orgId);

    const handleCreateChat = async (fileName: string) => {
        if (!rootPath) return;
        const newPath = await createChatMutation.mutateAsync({
            parentId: rootPath.id,
            fileName,
        });
        setCreateChatOpen(false);
        if (newPath) {
            navigate({
                to: '/$ownerId/$mountId/$chatId',
                params: { ownerId, mountId, chatId: newPath.id },
            });
        }
    };

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
                        chats.map((chat) => <ChatItem key={chat.id} chat={chat} condensed={condensed} />)
                    )}
                </SidebarSection>
            )}

            {teams && teams.length > 0 && (
                <>
                    <Separator />
                    <SidebarSection condensed={condensed} title={condensed ? undefined : 'Team Chats'}>
                        {teams.map((team) => (
                            <TeamChatItems key={team.id} teamId={team.id} condensed={condensed} />
                        ))}
                    </SidebarSection>
                </>
            )}

            {rootPath && (
                <DriveCreateItemDialog
                    open={createChatOpen}
                    onOpenChange={setCreateChatOpen}
                    onCreateItem={handleCreateChat}
                    isPending={createChatMutation.isPending}
                    type="Chat"
                    path={rootPath}
                />
            )}
        </div>
    );
}
