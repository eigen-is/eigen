import {MessageSquare, Plus, X} from 'lucide-react';
import {Button} from "@workspace/ui/components/button";
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {SidebarItem} from '@workspace/ui/components/layout/sidebar/sidebar-item';
import {AppLogo} from '@workspace/ui/components/layout/app-logo';
import {useCreateChat} from '@workspace/lib/chat';
import {useQuery} from "@tanstack/react-query";
import {driveApi} from "@workspace/lib/api";
import {driveKeys} from "@workspace/lib/drive";
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
    const ownChats = useQuery({
        queryKey: [...driveKeys.mime('application-eigenchat'), 'own'],
        queryFn: async () => {
            const response = await driveApi({ownerId}).mime({mimeType: 'application-eigenchat'}).get();
            return (response.data || []) as DrivePath[];
        },
        enabled: !!ownerId,
    });

    const sharedChats = useQuery({
        queryKey: [...driveKeys.shared('with-me'), 'chats'],
        queryFn: async () => {
            const response = await driveApi({ownerId}).shared['with-me'].get();
            const all = (response.data || []) as DrivePath[];
            return all.filter(p => p.mimeType === 'application/eigenchat');
        },
        enabled: !!ownerId,
    });

    const [createChatOpen, setCreateChatOpen] = useState(false);
    const createChatMutation = useCreateChat(ownerId, mountId);
    const isLoading = ownChats.isLoading || sharedChats.isLoading;
    const myChats = ownChats.data || [];
    const shared = sharedChats.data || [];

    const handleCreateChat = async (fileName: string) => {
        if (!rootPath) return;
        try {
            const newPath = await createChatMutation.mutateAsync({
                parentId: rootPath.id,
                fileName,
            });
            setCreateChatOpen(false);
            if (newPath) {
                window.location.href = `/${ownerId}/${mountId}/${newPath.id}`;
            }
        } catch (error: unknown) {
            toast.error(error instanceof Error ? error.message : "Failed to create chat");
        }
    };

    const renderChatItem = (chat: DrivePath) => (
        <SidebarItem
            key={chat.id}
            icon={<MessageSquare className="h-4 w-4"/>}
            label={chat.name || 'Unnamed chat'}
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

            {isLoading ? (
                <div className="flex justify-center py-4">
                    <EigenLoader/>
                </div>
            ) : (
                <>
                    <SidebarSection condensed={condensed}>
                        {!condensed && <p className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">My chats</p>}
                        {myChats.length === 0 ? (
                            <div className="px-3 py-2 text-xs text-muted-foreground">No chats yet</div>
                        ) : (
                            myChats.map(renderChatItem)
                        )}
                    </SidebarSection>

                    {shared.length > 0 && (
                        <SidebarSection condensed={condensed}>
                            {!condensed && <p className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">Shared with me</p>}
                            {shared.map(renderChatItem)}
                        </SidebarSection>
                    )}
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
