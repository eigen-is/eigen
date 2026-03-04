import {type ReactNode, useEffect, useRef} from 'react';
import {UserAvatar} from "../user-avatar";
import {EigenLoader} from "../eigen-loader";
import {cn} from "../../../lib/utils";
import {usePublicUser} from "@workspace/lib/public";
import {useContacts} from "@workspace/lib/contacts";
import {Paperclip} from "lucide-react";
import {useFileInfo} from "@workspace/lib/chat";
import {getDriveDownloadUrl, getDriveThumbnailUrl, getMailComposeUrl} from "@workspace/lib/api";
import {formatTime} from "@workspace/lib/date";
import {EMAIL_FIND_REGEX} from "@workspace/lib/validation";
import type {ChatMessage} from "@workspace/lib/types/chat";
import type {Contact} from "@workspace/lib/types/contact";
import {UserItem} from "@workspace/ui/components/layout/user-item";

type ChatMessageListProps = {
    messages: ChatMessage[];
    isLoading: boolean;
    currentUserId: string;
    ownerId?: string;
    mountId?: string;
    className?: string;
    emptyMessage?: string;
}

function isSameAuthorAndClose(prev: ChatMessage, curr: ChatMessage): boolean {
    if (prev.authorId !== curr.authorId) return false;
    const diff = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime();
    return diff < 5 * 60 * 1000;
}

function AttachmentChip({pathId, ownerId, mountId}: { pathId: string; ownerId: string; mountId: string }) {
    const {data: fileInfo} = useFileInfo(ownerId, mountId, pathId);

    const name = fileInfo?.details?.originalName || fileInfo?.name || pathId;
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

function InlineEmail({email}: { email: string }) {
    const {data} = usePublicUser(email);
    const name = data?.name || email.split('@')[0];
    return (
        <a
            href={getMailComposeUrl(email)}
            className="inline-flex items-baseline gap-1 text-blue-600 hover:underline"
        >
            <UserAvatar email={email} size="sm" className="h-4 w-4 inline-block relative top-0.5"/>
            <span>{name}</span>
        </a>
    );
}

function RichContent({text, className}: { text: string; className?: string }) {
    const parts: ReactNode[] = [];
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    const regex = new RegExp(EMAIL_FIND_REGEX);
    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIdx) {
            parts.push(text.slice(lastIdx, match.index));
        }
        parts.push(<InlineEmail key={match.index} email={match[0]}/>);
        lastIdx = regex.lastIndex;
    }
    if (lastIdx < text.length) {
        parts.push(text.slice(lastIdx));
    }
    return <p className={className}>{parts}</p>;
}

function InspectCard({target}: { target: string }) {
    const {data: contacts = []} = useContacts();
    const contact = (contacts as Contact[]).find(c =>
        c.email?.some(e => e.toLowerCase() === target.toLowerCase())
    );

    return (
        <div className="flex gap-4 p-4 rounded-lg border bg-card max-w-sm">
            <div className="shrink-0">
                <UserItem email={target} mailLink={true}/>
            </div>
            <div className="flex-1 min-w-0 space-y-1">
                {contact?.company && (
                    <p className="text-xs text-muted-foreground">{contact.jobTitle ? `${contact.jobTitle} at ` : ''}{contact.company}</p>
                )}
                {contact?.phone && contact.phone.length > 0 && contact.phone[0] && (
                    <p className="text-xs text-muted-foreground">{contact.phone[0]}</p>
                )}
            </div>
        </div>
    );
}

export function ChatMessageList({
                                    messages,
                                    isLoading,
                                    ownerId,
                                    mountId,
                                    className,
                                    emptyMessage = 'No messages yet. Start the conversation!',
                                }: ChatMessageListProps) {
    const bottomRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({behavior: 'smooth'});
    }, [messages.length]);

    if (isLoading) {
        return (
            <div className={cn("flex items-center justify-center flex-1", className)}>
                <EigenLoader/>
            </div>
        );
    }

    if (messages.length === 0) {
        return (
            <div className={cn("flex items-center justify-center flex-1", className)}>
                <p className="text-sm text-muted-foreground">{emptyMessage}</p>
            </div>
        );
    }

    return (
        <div className={cn("flex-1 overflow-y-auto", className)}>
            {messages.map((message, i) => {
                const isWhisper = message.type === 'whisper';
                const isEmote = message.type === 'emote';
                const isSystem = message.type === 'system';
                const isDeleted = !!message.deletedAt;
                const prev = i > 0 ? messages[i - 1] : null;
                const grouped = prev && !isSystem && !prev.deletedAt && prev.type !== 'system' && isSameAuthorAndClose(prev, message);

                if (isSystem) {
                    if (message.content.startsWith('inspect:')) {
                        const target = message.content.slice(8);
                        return (
                            <div key={message.id} className="flex gap-3 px-5 py-2">
                                <div className="w-9 shrink-0"/>
                                <InspectCard target={target}/>
                            </div>
                        );
                    }
                    return (
                        <div key={message.id} className="flex gap-3 px-5 py-2">
                            <div className="w-9 shrink-0"/>
                            <p className="text-sm text-muted-foreground italic whitespace-pre-wrap">{message.content}</p>
                        </div>
                    );
                }

                const displayName = message.authorEmail.split('@')[0] || message.authorEmail;

                if (isEmote && !isDeleted) {
                    return (
                        <div key={message.id} className="flex gap-3 px-5 py-1">
                            <div className="w-9 shrink-0 flex items-start justify-center pt-0.5">
                                <span className="text-muted-foreground text-xs">✦</span>
                            </div>
                            <RichContent
                                text={message.content}
                                className="text-sm text-muted-foreground italic whitespace-pre-wrap"
                            />
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
                                        <span
                                            className="text-xs text-muted-foreground">{formatTime(message.createdAt)}</span>
                                        <span className="text-xs text-orange-500 font-medium italic">whisper</span>
                                    </div>
                                )}
                                <RichContent
                                    text={message.content}
                                    className="text-sm text-muted-foreground italic whitespace-pre-wrap break-words"
                                />
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
                                <RichContent
                                    text={message.content}
                                    className="text-sm text-foreground whitespace-pre-wrap break-words"
                                />
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
