import {createFileRoute} from '@tanstack/react-router'
import {useAuth} from "@workspace/lib/auth";
import {useMessages, usePostMessage} from "@workspace/lib/chat";
import {MessageList} from "../components/chat/message-list";
import {MessageInput} from "../components/chat/message-input";
import {usePathInfo} from "@workspace/lib/drive";

function ChatView() {
    const {user} = useAuth();
    const {ownerId, mountId, chatId} = Route.useParams();

    const {data: messages = [], isLoading: messagesLoading} = useMessages(ownerId, mountId, chatId);
    const postMessage = usePostMessage(ownerId, mountId, chatId);
    const {data: chatPath} = usePathInfo(ownerId, mountId, chatId);

    const handleSendMessage = async (content: string) => {
        if (!content.trim()) return;
        await postMessage.mutateAsync({content});
    };

    return (
        <div className="flex flex-col h-full">
            <div className="border-b px-4 py-2 flex items-center">
                <span className="font-medium text-sm truncate">{chatPath?.name || 'Chat'}</span>
            </div>
            <MessageList
                messages={messages}
                isLoading={messagesLoading}
                currentUserId={user?.id || ''}
            />
            <MessageInput
                onSend={handleSendMessage}
                disabled={postMessage.isPending}
            />
        </div>
    );
}

export const Route = createFileRoute('/_auth/$ownerId/$mountId/$chatId')({
    component: ChatView,
})
