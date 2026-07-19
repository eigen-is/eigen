import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useIsGuest } from '@workspace/lib/auth';
import { useAllChats } from '@workspace/lib/chat';
import { EmptyState } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { ChatCreateWizard } from '@workspace/ui/components/layout/chat/chat-create-wizard';
import { MessageSquare, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';

function ChatIndex() {
    const navigate = useNavigate();
    const isGuest = useIsGuest();
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

    if (!isLoading && chats.length === 0) {
        return (
            <>
                <EmptyState
                    message="No chats yet"
                    icon={<MessageSquare className="h-12 w-12" />}
                    action={
                        isGuest ? undefined : (
                            <Button onClick={() => setCreateChatOpen(true)}>
                                <Plus className="h-4 w-4 mr-2" />
                                Create your first chat
                            </Button>
                        )
                    }
                />
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
