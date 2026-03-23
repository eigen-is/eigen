import {createFileRoute, redirect, useNavigate} from '@tanstack/react-router'
import {useAuth} from "@workspace/lib/auth";
import {useChats, useCreateChat} from "@workspace/lib/chat";
import {DEFAULT_MOUNT_ID, useRootFolder} from "@workspace/lib/drive";
import {Button} from "@workspace/ui/components/button";
import {EmptyState} from "@workspace/ui";
import {MessageSquare, Plus} from "lucide-react";
import {DriveCreateItemDialog} from "@workspace/ui/components/layout/drive/drive-create-folder-item";
import {useEffect, useState} from "react";

function ChatIndex() {
    const {user} = useAuth();
    const navigate = useNavigate();
    const mountId = DEFAULT_MOUNT_ID;
    const {data} = useChats(user?.id || '');
    const {data: root} = useRootFolder(user?.id || '', mountId);
    const [createChatOpen, setCreateChatOpen] = useState(false);
    const createChatMutation = useCreateChat(user?.id || '', mountId);

    // Auto-redirect to first chat if available
    useEffect(() => {
        if (data && data.length > 0) {
            const chat = data[0];
            navigate({
                to: '/$ownerId/$mountId/$chatId',
                params: {
                    ownerId: chat?.ownerId || '',
                    mountId: chat?.mountId || '',
                    chatId: chat?.id || ''
                }
            });
        }
    }, [data, navigate]);

    const handleCreateChat = async (fileName: string) => {
        if (!root) return;
        const newPath = await createChatMutation.mutateAsync({
            parentId: root.id,
            fileName,
        });
        setCreateChatOpen(false);
        if (newPath) {
            navigate({
                to: '/$ownerId/$mountId/$chatId',
                params: {
                    ownerId: user?.id || '',
                    mountId: mountId,
                    chatId: newPath.id
                }
            });
        }
    };

    if (data && data.length === 0) {
        return (
            <>
                <EmptyState
                    message="No chats yet"
                    icon={<MessageSquare className="h-12 w-12"/>}
                    action={
                        <Button onClick={() => setCreateChatOpen(true)}>
                            <Plus className="h-4 w-4 mr-2"/>
                            Create your first chat
                        </Button>
                    }
                />
                {root && (
                    <DriveCreateItemDialog
                        open={createChatOpen}
                        onOpenChange={setCreateChatOpen}
                        onCreateItem={handleCreateChat}
                        isPending={createChatMutation.isPending}
                        type="Chat"
                        path={root}
                    />
                )}
            </>
        );
    }

    return (
        <EmptyState message="Select a chat from the sidebar"/>
    );
}

export const Route = createFileRoute('/_auth/')({
    beforeLoad: ({context}) => {
        const userId = context.auth?.user?.id;
        if (!userId) {
            throw redirect({to: '/login'});
        }
    },
    component: ChatIndex,
})
