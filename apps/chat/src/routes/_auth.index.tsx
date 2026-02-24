import {createFileRoute} from '@tanstack/react-router'
import {useAuth} from "@workspace/lib/auth";
import {useChats, useCreateChat} from "@workspace/lib/chat";
import {useRootFolder, DEFAULT_MOUNT_ID} from "@workspace/lib/drive";
import {Button} from "@workspace/ui/components/button";
import {MessageSquare, Plus} from "lucide-react";
import {DriveCreateItemDialog} from "@workspace/ui/components/layout/drive/drive-create-folder-item";
import {useState} from "react";
import type {DrivePath} from "@workspace/lib/types/drive";
import {toast} from "sonner";

function ChatIndex() {
    const {user} = useAuth();
    const mountId = DEFAULT_MOUNT_ID;
    const {data: chats = []} = useChats(user?.id || '', mountId);
    const {data: root} = useRootFolder(user?.id || '', mountId);
    const [createChatOpen, setCreateChatOpen] = useState(false);
    const createChatMutation = useCreateChat(user?.id || '', mountId);

    const handleCreateChat = async (fileName: string) => {
        if (!root) return;
        try {
            const newPath = await createChatMutation.mutateAsync({
                parentId: root.id,
                fileName,
            });
            setCreateChatOpen(false);
            if (newPath) {
                window.location.href = `/${user?.id}/${mountId}/${newPath.id}`;
            }
        } catch (error: unknown) {
            toast.error(error instanceof Error ? error.message : "Failed to create chat");
        }
    };

    if (chats.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full w-full gap-4">
                <MessageSquare className="h-12 w-12 text-muted-foreground"/>
                <p className="text-muted-foreground">No chats yet</p>
                <Button onClick={() => setCreateChatOpen(true)}>
                    <Plus className="h-4 w-4 mr-2"/>
                    Create your first chat
                </Button>
                {root && (
                    <DriveCreateItemDialog
                        open={createChatOpen}
                        onOpenChange={setCreateChatOpen}
                        onCreateItem={handleCreateChat}
                        isPending={createChatMutation.isPending}
                        type="Chat"
                        path={root as DrivePath}
                    />
                )}
            </div>
        );
    }

    return (
        <div className="flex items-center justify-center h-full w-full">
            <p className="text-muted-foreground">Select a chat from the sidebar</p>
        </div>
    );
}

export const Route = createFileRoute('/_auth/')({
    component: ChatIndex,
})
