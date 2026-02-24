import {useEffect, useRef} from 'react';
import {EigenLoader} from "@workspace/ui";
import type {ChatMessage} from "@workspace/lib/types/chat";
import {cn} from "@workspace/ui/lib/utils";
import {UserAvatar} from "@workspace/ui";
import {Paperclip} from "lucide-react";

type MessageListProps = {
    messages: ChatMessage[];
    isLoading: boolean;
    currentUserId: string;
    ownerId?: string;
    mountId?: string;
}

function formatTime(date: Date): string {
    return new Date(date).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}

function isSameAuthorAndClose(prev: ChatMessage, curr: ChatMessage): boolean {
    if (prev.authorId !== curr.authorId) return false;
    const diff = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime();
    return diff < 5 * 60 * 1000;
}

export function MessageList({messages, isLoading, currentUserId, ownerId, mountId}: MessageListProps) {
    const bottomRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({behavior: 'smooth'});
    }, [messages.length]);

    if (isLoading) {
        return (
            <div className="flex items-center justify-center flex-1">
                <EigenLoader/>
            </div>
        );
    }

    if (messages.length === 0) {
        return (
            <div className="flex items-center justify-center flex-1">
                <p className="text-sm text-muted-foreground">No messages yet. Start the conversation!</p>
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-y-auto">
            {messages.map((message, i) => {
                const isWhisper = message.type === 'whisper';
                const isEmote = message.type === 'emote';
                const isSystem = message.type === 'system';
                const isDeleted = !!message.deletedAt;
                const prev = i > 0 ? messages[i - 1] : null;
                const grouped = prev && !isSystem && !prev.deletedAt && prev.type !== 'system' && isSameAuthorAndClose(prev, message);

                if (isSystem) {
                    return (
                        <div key={message.id} className="flex justify-center py-2">
                            <span className="text-xs text-muted-foreground italic">{message.content}</span>
                        </div>
                    );
                }

                const displayName = message.authorEmail.split('@')[0] || message.authorEmail;

                return (
                    <div
                        key={message.id}
                        className={cn(
                            "flex gap-3 px-5 hover:bg-muted/50 transition-colors",
                            grouped ? "pt-0.5" : "pt-3",
                            isWhisper && "bg-orange-50 hover:bg-orange-100/50"
                        )}
                    >
                        <div className="w-9 shrink-0 pt-0.5">
                            {!grouped && (
                                <UserAvatar
                                    name={message.authorEmail}
                                    email={message.authorEmail}
                                    userId={message.authorEmail}
                                    size="sm"
                                />
                            )}
                        </div>
                        <div className="flex-1 min-w-0 pb-1">
                            {!grouped && (
                                <div className="flex items-baseline gap-2">
                                    <span className="text-sm font-bold text-foreground">
                                        {displayName}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        {formatTime(message.createdAt)}
                                    </span>
                                    {isWhisper && (
                                        <span className="text-xs text-orange-500 font-medium">whisper</span>
                                    )}
                                    {message.editedAt && !isDeleted && (
                                        <span className="text-xs text-muted-foreground">(edited)</span>
                                    )}
                                </div>
                            )}
                            {isDeleted ? (
                                <p className="text-sm text-muted-foreground italic">This message was deleted.</p>
                            ) : isEmote ? (
                                <p className="text-sm italic text-muted-foreground">
                                    {displayName} {message.content}
                                </p>
                            ) : (
                                <p className="text-sm text-foreground whitespace-pre-wrap break-words">
                                    {message.content}
                                </p>
                            )}
                            {message.attachments && message.attachments.length > 0 && !isDeleted && (
                                <div className="flex flex-wrap gap-2 mt-1">
                                    {message.attachments.map((pathId) => (
                                        <a
                                            key={pathId}
                                            href={ownerId && mountId ? `/api/drive/${ownerId}/${mountId}/download/${pathId}` : '#'}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-muted text-xs text-foreground hover:bg-muted/80 transition-colors border"
                                        >
                                            <Paperclip className="h-3 w-3 text-muted-foreground"/>
                                            <span className="truncate max-w-[200px]">{pathId}</span>
                                        </a>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                );
            })}
            <div ref={bottomRef} className="h-3"/>
        </div>
    );
}
