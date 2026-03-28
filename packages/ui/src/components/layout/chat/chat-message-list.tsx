import { getDriveDownloadUrl, getDriveThumbnailUrl } from '@workspace/lib/api';
import { useContacts } from '@workspace/lib/contacts';
import { formatTime } from '@workspace/lib/date';
import { useFolderLookup } from '@workspace/lib/drive';
import { usePublicUser } from '@workspace/lib/public';
import type { ChatMessage } from '@workspace/lib/types/chat';
import type { Contact } from '@workspace/lib/types/contact';
import { EMAIL_FIND_REGEX } from '@workspace/lib/validation';
import { UserItem } from '@workspace/ui/components/layout/user-item';
import { Paperclip } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../components/hover-card';
import { cn } from '../../../lib/utils';
import { LoadingState } from '../app/loading-state';
import { EigenLoader } from '../braket/eigen-loader.tsx';
import { usePreview } from '../preview-provider';
import { UserAvatar } from '../user-avatar';

type ChatMessageListProps = {
    messages: ChatMessage[];
    isLoading: boolean;
    currentUserId: string;
    ownerId?: string;
    mountId?: string;
    mediaFolderId?: string | null;
    className?: string;
    emptyMessage?: string;
    hasOlderMessages?: boolean;
    isFetchingOlderMessages?: boolean;
    onLoadMore?: () => void;
};

function isSameAuthorAndClose(prev: ChatMessage, curr: ChatMessage): boolean {
    if (prev.authorId !== curr.authorId) return false;
    const diff = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime();
    return diff < 5 * 60 * 1000;
}

function AttachmentChip({
    fileName,
    ownerId,
    mountId,
    mediaFolderId,
}: {
    fileName: string;
    ownerId: string;
    mountId: string;
    mediaFolderId: string;
}) {
    const { findByName } = useFolderLookup(ownerId, mountId, mediaFolderId);
    const fileInfo = findByName(fileName);
    const { openPreview } = usePreview();

    const name = fileInfo?.details?.originalName || fileInfo?.name || fileName;
    const downloadUrl = fileInfo ? getDriveDownloadUrl(ownerId, mountId, fileInfo.id) : '#';
    const thumbnailUrl = fileInfo?.thumbnail ? getDriveThumbnailUrl(ownerId, mountId, fileInfo.thumbnail) : null;
    const isImage = fileInfo?.mimeType?.startsWith('image/');

    const handleClick = (e: React.MouseEvent) => {
        if (fileInfo) {
            e.preventDefault();
            openPreview(fileInfo);
        }
    };

    return (
        <a
            href={downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md bg-muted text-xs text-foreground hover:bg-muted/80 transition-colors border overflow-hidden"
            onClick={handleClick}
        >
            {thumbnailUrl && isImage ? (
                <img src={thumbnailUrl} alt={name} className="h-10 w-10 object-cover rounded-l-md" />
            ) : null}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                {!thumbnailUrl && <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />}
                <span className="truncate max-w-[200px]">{name}</span>
            </div>
        </a>
    );
}

function InlineEmail({ email }: { email: string }) {
    const { data } = usePublicUser(email);
    const name = data?.name || email.split('@')[0];
    return (
        <HoverCard>
            <HoverCardTrigger asChild>
                <span className="text-primary cursor-default font-medium underline hover:no-underline">{name}</span>
            </HoverCardTrigger>
            <HoverCardContent className="w-auto p-3">
                <UserItem email={email} mailLink />
            </HoverCardContent>
        </HoverCard>
    );
}

const URL_REGEX = /https?:\/\/[^\s<>'")\]]+[^\s<>'")\].,;:!?]/g;

type RichToken = { index: number; end: number; type: 'email' | 'url'; value: string };

function tokenize(text: string): RichToken[] {
    const tokens: RichToken[] = [];
    const emailRegex = new RegExp(EMAIL_FIND_REGEX);
    const urlRegex = new RegExp(URL_REGEX);

    let match: RegExpExecArray | null;
    while ((match = emailRegex.exec(text)) !== null) {
        tokens.push({ index: match.index, end: match.index + match[0].length, type: 'email', value: match[0] });
    }
    while ((match = urlRegex.exec(text)) !== null) {
        tokens.push({ index: match.index, end: match.index + match[0].length, type: 'url', value: match[0] });
    }

    tokens.sort((a, b) => a.index - b.index);
    return tokens;
}

function RichContent({ text, className }: { text: string; className?: string }) {
    const parts: ReactNode[] = [];
    const tokens = tokenize(text);

    let lastIdx = 0;
    for (const token of tokens) {
        if (token.index < lastIdx) continue;
        if (token.index > lastIdx) {
            parts.push(text.slice(lastIdx, token.index));
        }
        if (token.type === 'email') {
            parts.push(<InlineEmail key={token.index} email={token.value} />);
        } else {
            parts.push(
                <a
                    key={token.index}
                    href={token.value}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline break-all"
                >
                    {token.value}
                </a>,
            );
        }
        lastIdx = token.end;
    }
    if (lastIdx < text.length) {
        parts.push(text.slice(lastIdx));
    }
    return <p className={className}>{parts}</p>;
}

function InspectCard({ target }: { target: string }) {
    const { data: contacts = [] } = useContacts();
    const contact = (contacts as Contact[]).find((c) => c.email?.some((e) => e.toLowerCase() === target.toLowerCase()));

    return (
        <div className="flex gap-4 p-4 rounded-lg border bg-card max-w-sm">
            <div className="shrink-0">
                <UserItem email={target} mailLink={true} />
            </div>
            <div className="flex-1 min-w-0 space-y-1">
                {contact?.company && (
                    <p className="text-xs text-muted-foreground">
                        {contact.jobTitle ? `${contact.jobTitle} at ` : ''}
                        {contact.company}
                    </p>
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
    mediaFolderId,
    className,
    emptyMessage = 'No messages yet. Start the conversation!',
    hasOlderMessages,
    isFetchingOlderMessages,
    onLoadMore,
}: ChatMessageListProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const lastMessageIdRef = useRef('');
    const isInitialLoadRef = useRef(true);

    const scrollToBottom = useCallback(() => {
        requestAnimationFrame(() => {
            const container = scrollRef.current;
            if (container) container.scrollTop = container.scrollHeight;
        });
    }, []);

    // Scroll to bottom on initial load
    useEffect(() => {
        if (messages.length > 0 && isInitialLoadRef.current) {
            isInitialLoadRef.current = false;
            scrollToBottom();
        }
    }, [messages.length, scrollToBottom]);

    // Auto-scroll when a new message appears at the end
    useEffect(() => {
        const lastId = messages[messages.length - 1]?.id ?? '';
        const prevLastId = lastMessageIdRef.current;
        lastMessageIdRef.current = lastId;

        if (!prevLastId || lastId === prevLastId) return;

        const container = scrollRef.current;
        if (!container) return;

        const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
        if (isNearBottom) {
            scrollToBottom();
        }
    }, [messages, scrollToBottom]);

    // Load more when scrolling near the top
    const onLoadMoreRef = useRef(onLoadMore);
    onLoadMoreRef.current = onLoadMore;

    const handleScroll = useCallback(() => {
        if (!onLoadMoreRef.current || !hasOlderMessages || isFetchingOlderMessages) return;
        const container = scrollRef.current;
        if (container && container.scrollTop < 200) {
            onLoadMoreRef.current();
        }
    }, [hasOlderMessages, isFetchingOlderMessages]);

    useEffect(() => {
        const container = scrollRef.current;
        if (!container) return;
        container.addEventListener('scroll', handleScroll, { passive: true });
        return () => container.removeEventListener('scroll', handleScroll);
    }, [handleScroll]);

    if (isLoading) {
        return <LoadingState />;
    }

    if (messages.length === 0) {
        return (
            <div className={cn('flex items-center justify-center flex-1', className)}>
                <p className="text-sm text-muted-foreground">{emptyMessage}</p>
            </div>
        );
    }

    return (
        <div ref={scrollRef} className={cn('flex-1 overflow-y-auto', className)}>
            {isFetchingOlderMessages && (
                <div className="flex justify-center py-3">
                    <EigenLoader />
                </div>
            )}
            {messages.map((message, i) => {
                const isWhisper = message.type === 'whisper';
                const isEmote = message.type === 'emote';
                const isSystem = message.type === 'system';
                const isDeleted = !!message.deletedAt;
                const prev = i > 0 ? messages[i - 1] : null;
                const grouped =
                    prev &&
                    !isSystem &&
                    !prev.deletedAt &&
                    prev.type !== 'system' &&
                    isSameAuthorAndClose(prev, message);

                if (isSystem) {
                    if (message.content.startsWith('inspect:')) {
                        const target = message.content.slice(8);
                        return (
                            <div key={message.id} className="flex gap-3 px-5 py-2">
                                <div className="w-9 shrink-0" />
                                <InspectCard target={target} />
                            </div>
                        );
                    }
                    return (
                        <div key={message.id} className="flex gap-3 px-5 py-2">
                            <div className="w-9 shrink-0" />
                            <p className="text-sm text-muted-foreground italic whitespace-pre-wrap">
                                {message.content}
                            </p>
                        </div>
                    );
                }

                const displayName = message.authorEmail.split('@')[0] || message.authorEmail;

                if (isEmote && !isDeleted) {
                    return (
                        <div key={message.id} className={cn('flex gap-3 px-5', grouped ? 'py-1' : 'pt-3')}>
                            <div className="w-9 shrink-0 pt-0.5">
                                {!grouped ? (
                                    <UserAvatar
                                        name={message.authorEmail}
                                        email={message.authorEmail}
                                        userId={message.authorEmail}
                                        size="sm"
                                    />
                                ) : (
                                    <div className="flex items-start justify-center">
                                        <span className="text-muted-foreground text-xs">✦</span>
                                    </div>
                                )}
                            </div>
                            <div className="flex-1 min-w-0 pb-1">
                                {!grouped && (
                                    <div className="flex items-baseline gap-2">
                                        <span className="text-sm font-bold text-foreground">{displayName}</span>
                                        <span className="text-xs text-muted-foreground">
                                            {formatTime(message.createdAt)}
                                        </span>
                                    </div>
                                )}
                                <RichContent
                                    text={message.content}
                                    className="text-sm text-muted-foreground italic whitespace-pre-wrap"
                                />
                            </div>
                        </div>
                    );
                }

                if (isWhisper && !isDeleted) {
                    return (
                        <div
                            key={message.id}
                            className={cn(
                                'flex gap-3 px-5 hover:bg-primary/10 transition-colors',
                                grouped ? 'pt-0.5' : 'pt-3',
                                'bg-primary/5',
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
                                        <span className="text-xs text-muted-foreground">
                                            {formatTime(message.createdAt)}
                                        </span>
                                        <span className="text-xs text-primary font-medium italic">whisper</span>
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
                            'flex gap-3 px-5 hover:bg-muted/50 transition-colors',
                            grouped ? 'pt-0.5' : 'pt-3',
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
                            {message.attachments &&
                                message.attachments.length > 0 &&
                                !isDeleted &&
                                ownerId &&
                                mountId &&
                                mediaFolderId && (
                                    <div className="flex flex-wrap gap-2 mt-1">
                                        {message.attachments.map((name) => (
                                            <AttachmentChip
                                                key={name}
                                                fileName={name}
                                                ownerId={ownerId}
                                                mountId={mountId}
                                                mediaFolderId={mediaFolderId}
                                            />
                                        ))}
                                    </div>
                                )}
                        </div>
                    </div>
                );
            })}
            <div className="h-3" />
        </div>
    );
}
