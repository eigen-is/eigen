import { useChatRoom } from '@workspace/lib/chat';
import { useMediaResolver } from '@workspace/lib/drive';
import { cn } from '../../../lib/utils';
import { ChatMessageInput } from '../chat/chat-message-input';
import { ChatMessageList } from '../chat/chat-message-list';

type CommentThreadProps = {
    ownerId: string;
    mountId: string;
    chatName: string;
    className?: string;
};

function CommentThreadInner({
    ownerId,
    mountId,
    chatId,
    className,
}: { chatId: string } & Omit<CommentThreadProps, 'chatName'>) {
    const chat = useChatRoom(ownerId, mountId, chatId);

    return (
        <div className={cn('flex flex-col flex-1 min-h-0 overflow-hidden', className)}>
            <ChatMessageList
                messages={chat.messages}
                isLoading={chat.isLoading}
                currentUserId={chat.currentUserId}
                ownerId={ownerId}
                mountId={mountId}
                mediaFolderId={chat.mediaFolderId}
                emptyMessage=""
                className="flex-1 min-h-0"
            />
            <ChatMessageInput
                onSend={chat.handleSendMessage}
                disabled={chat.disabled}
                readOnly={chat.readOnly}
                placeholder="Reply..."
                roomMembers={chat.roomMembers}
                currentUserEmail={chat.currentUserEmail}
                messageCount={chat.messages.length}
            />
        </div>
    );
}

export function CommentThread({ ownerId, mountId, chatName, className }: CommentThreadProps) {
    const { resolveChatId } = useMediaResolver();
    const chatId = resolveChatId(chatName);

    if (!chatId) {
        return <div className={cn('px-4 pb-4 text-sm text-muted-foreground', className)}>Comment not found.</div>;
    }

    return <CommentThreadInner ownerId={ownerId} mountId={mountId} chatId={chatId} className={className} />;
}
