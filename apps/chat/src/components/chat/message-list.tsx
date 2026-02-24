import {useEffect, useRef} from 'react';
import {EigenLoader} from "@workspace/ui";
import type {ChatMessage} from "@workspace/lib/types/chat";
import {cn} from "@workspace/ui/lib/utils";
import {UserAvatar} from "@workspace/ui";
import {Paperclip} from "lucide-react";
import {useQuery} from "@tanstack/react-query";
import {driveApi, getDriveDownloadUrl, getDriveThumbnailUrl} from "@workspace/lib/api";
import type {DrivePath} from "@workspace/lib/types/drive";

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

function AttachmentChip({pathId, ownerId, mountId}: { pathId: string; ownerId: string; mountId: string }) {
    const {data: fileInfo} = useQuery({
        queryKey: ['drive', 'file', pathId],
        queryFn: async () => {
            const res = await driveApi({ownerId})({mountId}).file({pathId}).get();
            return res.data as DrivePath | null;
        },
        staleTime: 60_000,
    });

    const name = fileInfo?.name || pathId;
    const downloadUrl = getDriveDownloadUrl(ownerId, mountId, pathId);
    const thumbnailUrl = fileInfo?.thumbnail ? getDriveThumbnailUrl(ownerId, mountId, fileInfo.thumbnail) : null;
    const isImage = fileInfo?.mimeType?.startsWith('image/');

    return (
        <a
            href={downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md bg-muted text-xs text-foreground hover:bg-muted/80 transition-colors border overflow-hidden"
        >
            {thumbnailUrl && isImage ? (
                <img src={thumbnailUrl} alt={name} className="h-10 w-10 object-cover rounded-l-md"/>
            ) : null}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                {!thumbnailUrl && <Paperclip className="h-3 w-3 text-muted-foreground shrink-0"/>}
                <span className="truncate max-w-[200px]">{name}</span>
            </div>
        </a>
    );
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

                if (isEmote && !isDeleted) {
                    return (
                        <div key={message.id} className="px-5 py-1">
                            <p className="text-sm text-muted-foreground italic">
                                {displayName} {message.content}
                            </p>
                        </div>
                    );
                }

                if (isWhisper && !isDeleted) {
                    return (
                        <div
                            key={message.id}
                            className={cn(
                                "flex gap-3 px-5 hover:bg-orange-50/50 transition-colors",
                                grouped ? "pt-0.5" : "pt-3",
                                "bg-orange-50/30"
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
                                        <span className="text-sm font-bold text-foreground">{displayName}</span>
                                        <span className="text-xs text-muted-foreground">{formatTime(message.createdAt)}</span>
                                        <span className="text-xs text-orange-500 font-medium italic">whisper</span>
                                    </div>
                                )}
                                <p className="text-sm text-muted-foreground italic whitespace-pre-wrap break-words">
                                    {message.content}
                                </p>
                            </div>
                        </div>
                    );
                }

                return (
                    <div
                        key={message.id}
                        className={cn(
                            "flex gap-3 px-5 hover:bg-muted/50 transition-colors",
                            grouped ? "pt-0.5" : "pt-3",
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
                                    {message.editedAt && !isDeleted && (
                                        <span className="text-xs text-muted-foreground">(edited)</span>
                                    )}
                                </div>
                            )}
                            {isDeleted ? (
                                <p className="text-sm text-muted-foreground italic">This message was deleted.</p>
                            ) : (
                                <p className="text-sm text-foreground whitespace-pre-wrap break-words">
                                    {message.content}
                                </p>
                            )}
                            {message.attachments && message.attachments.length > 0 && !isDeleted && ownerId && mountId && (
                                <div className="flex flex-wrap gap-2 mt-1">
                                    {message.attachments.map((id) => (
                                        <AttachmentChip key={id} pathId={id} ownerId={ownerId} mountId={mountId}/>
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
