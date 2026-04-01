import { useChatRoom } from '@workspace/lib/chat';
import { formatTimeAgo } from '@workspace/lib/date';
import { useMediaResolver } from '@workspace/lib/drive';
import type { CommentEntry } from '@workspace/lib/types/chat';
import { Check, RotateCcw } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Button } from '../../button';
import { ChatMessageInput } from '../chat/chat-message-input';
import { ChatMessageList } from '../chat/chat-message-list';
import { UserAvatar } from '../user-avatar';

type CommentThreadProps = {
    ownerId: string;
    mountId: string;
    comment: CommentEntry;
    anchorText?: string;
    compact?: boolean;
    onResolve?: () => void;
    onReopen?: () => void;
    onScrollToAnchor?: () => void;
    className?: string;
};

function CommentThreadInner({
    ownerId,
    mountId,
    chatId,
    comment,
    anchorText,
    compact,
    onResolve,
    onReopen,
    onScrollToAnchor,
    className,
}: CommentThreadProps & { chatId: string }) {
    const chat = useChatRoom(ownerId, mountId, chatId);

    return (
        <div className={cn('flex flex-col overflow-hidden', className)}>
            {anchorText && (
                <button
                    type="button"
                    className="text-left rounded bg-muted border-l-4 border-primary px-3 py-2 mb-2 cursor-pointer hover:bg-muted/80 transition-colors"
                    onClick={onScrollToAnchor}
                >
                    <p className="text-xs text-muted-foreground italic line-clamp-2">"{anchorText}"</p>
                </button>
            )}

            <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2 min-w-0">
                    {comment.lastAuthorEmail && (
                        <>
                            <UserAvatar
                                name={comment.lastAuthorEmail}
                                email={comment.lastAuthorEmail}
                                userId={comment.lastAuthorEmail}
                                size="sm"
                            />
                            <span className="text-xs font-medium truncate">
                                {comment.lastAuthorEmail.split('@')[0]}
                            </span>
                        </>
                    )}
                    {comment.lastActivityAt && (
                        <span className="text-xs text-muted-foreground shrink-0">
                            {formatTimeAgo(comment.lastActivityAt)}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    {comment.status === 'open' && onResolve && (
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onResolve} title="Resolve">
                            <Check className="h-3.5 w-3.5" />
                        </Button>
                    )}
                    {comment.status === 'resolved' && onReopen && (
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onReopen} title="Reopen">
                            <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                    )}
                </div>
            </div>

            {compact ? (
                <p className="text-sm text-foreground line-clamp-3 whitespace-pre-wrap">{comment.lastMessageSnippet}</p>
            ) : (
                <>
                    <ChatMessageList
                        messages={chat.messages}
                        isLoading={chat.isLoading}
                        currentUserId={chat.currentUserId}
                        ownerId={ownerId}
                        mountId={mountId}
                        mediaFolderId={chat.mediaFolderId}
                        emptyMessage=""
                        className="flex-1 min-h-0 max-h-[40vh]"
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
                </>
            )}

            {compact && comment.messageCount > 1 && (
                <span className="text-xs text-muted-foreground mt-1">
                    {comment.messageCount - 1} {comment.messageCount === 2 ? 'reply' : 'replies'}
                </span>
            )}
        </div>
    );
}

export function CommentThread(props: CommentThreadProps) {
    const { resolveChatId } = useMediaResolver();
    const chatId = resolveChatId(props.comment.chatName);

    if (!chatId) {
        return <div className={cn('px-3 py-2 text-xs text-muted-foreground', props.className)}>Comment not found.</div>;
    }

    return <CommentThreadInner {...props} chatId={chatId} />;
}
