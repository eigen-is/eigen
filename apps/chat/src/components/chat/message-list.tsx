import {useEffect, useRef} from 'react';
import {EigenLoader} from "@workspace/ui";
import type {ChatMessage} from "@workspace/lib/types/chat";
import {cn} from "@workspace/ui/lib/utils";
import {UserAvatar} from "@workspace/ui";

type MessageListProps = {
    messages: ChatMessage[];
    isLoading: boolean;
    currentUserId: string;
}

export function MessageList({messages, isLoading, currentUserId}: MessageListProps) {
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
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
            {messages.map((message) => {
                const isOwn = message.authorId === currentUserId;
                const isWhisper = message.type === 'whisper';
                const isSystem = message.type === 'system';
                const isDeleted = !!message.deletedAt;

                if (isSystem) {
                    return (
                        <div key={message.id} className="flex justify-center">
                            <span className="text-xs text-muted-foreground italic">{message.content}</span>
                        </div>
                    );
                }

                return (
                    <div key={message.id} className={cn("flex gap-3", isOwn && "flex-row-reverse")}>
                        <UserAvatar
                            name={message.authorEmail}
                            email={message.authorEmail}
                            userId={message.authorEmail}
                            size="sm"
                        />
                        <div className={cn("max-w-[70%]", isOwn && "text-right")}>
                            <div className="flex items-baseline gap-2 mb-1">
                                <span className={cn("text-xs font-medium", isOwn && "ml-auto")}>
                                    {message.authorEmail}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    {new Date(message.createdAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}
                                </span>
                                {isWhisper && (
                                    <span className="text-xs text-orange-500 italic">whisper</span>
                                )}
                                {message.editedAt && !isDeleted && (
                                    <span className="text-xs text-muted-foreground italic">edited</span>
                                )}
                            </div>
                            <div className={cn(
                                "rounded-lg px-3 py-2 text-sm inline-block",
                                isDeleted
                                    ? "bg-muted text-muted-foreground italic"
                                    : isOwn
                                        ? "bg-primary text-primary-foreground"
                                        : "bg-muted",
                                isWhisper && "border border-orange-300"
                            )}>
                                {isDeleted ? 'Message deleted' : message.content}
                            </div>
                        </div>
                    </div>
                );
            })}
            <div ref={bottomRef}/>
        </div>
    );
}
