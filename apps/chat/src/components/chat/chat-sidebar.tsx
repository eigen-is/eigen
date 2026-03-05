import {MessageSquare, Plus, X} from 'lucide-react';
import {Button} from "@workspace/ui/components/button";
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {SidebarItem} from '@workspace/ui/components/layout/sidebar/sidebar-item';
import {AppLogo} from '@workspace/ui/components/layout/app/app-logo.tsx';
import {useChats, useCreateChat} from '@workspace/lib/chat';
import {getChatRoomUrl} from "@workspace/lib/api";
import {EigenLoader} from "@workspace/ui";
import {DriveCreateItemDialog} from "@workspace/ui/components/layout/drive/drive-create-folder-item";
import {useState} from "react";
import type {DrivePath} from "@workspace/lib/types/drive";
import {toast} from "sonner";

type ChatSidebarProps = {
    condensed?: boolean;
    isMobile?: boolean;
    onClose?: () => void;
    ownerId: string;
    mountId: string;
    rootPath: DrivePath | null;
}

export function ChatSidebar({
                                condensed = false,
                                isMobile = false,
                                onClose,
                                ownerId,
                                mountId,
                                rootPath,
                            }: ChatSidebarProps) {
    const {data: chats, isLoading} = useChats(ownerId);
    const [createChatOpen, setCreateChatOpen] = useState(false);
    const createChatMutation = useCreateChat(ownerId, mountId);

    const handleCreateChat = async (fileName: string) => {
        if (!rootPath) return;
        try {
            const newPath = await createChatMutation.mutateAsync({
                parentId: rootPath.id,
                fileName,
            });
            setCreateChatOpen(false);
            if (newPath) {
                window.location.href = getChatRoomUrl(ownerId, mountId, newPath.id);
            }
        } catch (error: unknown) {
            toast.error(error instanceof Error ? error.message : "Failed to create chat");
        }
    };

    const renderChatItem = (chat: DrivePath) => (
        <SidebarItem
            key={chat.id}
            icon={<MessageSquare className="h-4 w-4"/>}
            label={(chat.name || 'Unnamed chat').replace(/\.eigenchat$/, '')}
            to={`/${chat.ownerId}/${chat.mountId}/${chat.id}`}
            condensed={condensed}
        />
    );

    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
            {isMobile && (
                <div className="flex items-center h-12 bg-app px-4">
                    <Button variant="ghost" size="icon" onClick={onClose}
                            className="mr-2 text-white hover:bg-primary/20 hover:text-white">
                        <X className="h-5 w-5"/>
                        <span className="sr-only">Close menu</span>
                    </Button>
                    <AppLogo appName="chat"/>
                </div>
            )}

            <div className="px-3 py-2">
                <Button
                    variant="default"
                    size={condensed ? "icon" : "default"}
                    className={`${condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}`}
                    onClick={() => setCreateChatOpen(true)}
                >
                    <Plus className="h-4 w-4"/>
                    {!condensed && <span>New chat</span>}
                </Button>
            </div>

            {isLoading || !chats ? (
                <div className="flex justify-center py-4">
                    <EigenLoader/>
                </div>
            ) : (
                <>
                    <SidebarSection condensed={condensed}>
                        {chats.length === 0 ? (
                            <div className="px-3 py-2 text-xs text-muted-foreground">No chats yet</div>
                        ) : (
                            chats.map(renderChatItem)
                        )}
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
