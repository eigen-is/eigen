import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useIsGuest } from '@workspace/lib/auth';
import { useAllChats } from '@workspace/lib/chat';
import { EmptyState } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { ChatCreateWizard } from '@workspace/ui/components/chat/chat-create-wizard';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout';
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

    const noChats = !isLoading && chats.length === 0;

    return (
        <>
            <ColumnLayout>
                {/* Chat's list is the sidebar, so this is the only column. */}
                <Column id="messages" width="flex" onBack="sidebar">
                    {noChats ? (
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
                    ) : (
                        <EmptyState message="Select a chat to view details" />
                    )}
                </Column>
            </ColumnLayout>

            {noChats && !isGuest && (
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

export const Route = createFileRoute('/_auth/')({
    component: ChatIndex,
});
