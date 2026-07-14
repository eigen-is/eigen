import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useAllChats } from '@workspace/lib/chat';
import type { DrivePath } from '@workspace/lib/types/drive';
import { EmptyState } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { DriveCreateEigenDoc } from '@workspace/ui/components/layout/drive/drive-create-eigendoc';
import { MessageSquare, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

function ChatIndex() {
    const navigate = useNavigate();
    const { chats, isLoading } = useAllChats();
    const [createChatOpen, setCreateChatOpen] = useState(false);

    useEffect(() => {
        if (chats.length > 0) {
            const chat = chats[0];
            navigate({
                to: '/$ownerId/$mountId/$chatId',
                params: {
                    ownerId: chat?.ownerId || '',
                    mountId: chat?.mountId || '',
                    chatId: chat?.id || '',
                },
            });
        }
    }, [chats, navigate]);

    const handleAfterCreate = useCallback(
        (newPath: DrivePath) => {
            navigate({
                to: '/$ownerId/$mountId/$chatId',
                params: { ownerId: newPath.ownerId, mountId: newPath.mountId, chatId: newPath.id },
            });
        },
        [navigate],
    );

    if (!isLoading && chats.length === 0) {
        return (
            <>
                <EmptyState
                    message="No chats yet"
                    icon={<MessageSquare className="h-12 w-12" />}
                    action={
                        <Button onClick={() => setCreateChatOpen(true)}>
                            <Plus className="h-4 w-4 mr-2" />
                            Create your first chat
                        </Button>
                    }
                />
                <DriveCreateEigenDoc
                    open={createChatOpen}
                    onOpenChange={setCreateChatOpen}
                    type="chat"
                    openInNewTab={false}
                    onAfterCreate={handleAfterCreate}
                />
            </>
        );
    }

    return <EmptyState message="Select a chat to view details" />;
}

export const Route = createFileRoute('/_auth/')({
    beforeLoad: ({ context }) => {
        const userId = context.auth?.user?.id;
        if (!userId) {
            throw redirect({ to: '/login' });
        }
    },
    component: ChatIndex,
});
