import { getDriveDownloadUrl } from '@workspace/lib/api';
import { useContacts } from '@workspace/lib/contacts';
import { formatDateTime } from '@workspace/lib/date';
import { useCopyFiles, useFolderLookup } from '@workspace/lib/drive';
import type { ChatMessage } from '@workspace/lib/types/chat';
import { isAttachmentReference } from '@workspace/lib/types/chat';
import { EMAIL_FIND_REGEX } from '@workspace/lib/validation';
import { UserItem } from '@workspace/ui/components/layout/user-item';
import { UserNameCard } from '@workspace/ui/components/layout/user-name-card';
import { Check, Download, Pencil, Trash2, X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../../lib/utils';
import { LoadingState } from '../app/loading-state';
import { AttachmentChip } from '../attachment/attachment-chip';
import { ReferenceAttachmentChip } from '../attachment/reference-attachment-chip';
import { EigenLoader } from '../braket/eigen-loader.tsx';
import { DriveLocationPicker } from '../drive/drive-location-picker';
import { TooltipButton } from '../toolbar/tooltip-button';
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
    onEditMessage?: (message: ChatMessage) => void;
    onDeleteMessage?: (message: ChatMessage) => void;
    editingMessageId?: string | null;
    onSaveEdit?: (messageId: string, content: string) => void;
    onCancelEdit?: () => void;
};

function isSameAuthorAndClose(prev: ChatMessage, curr: ChatMessage): boolean {
    if (prev.authorId !== curr.authorId) return false;
    const diff = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime();
    return diff < 5 * 60 * 1000;
}

function InlineEmail({ email }: { email: string }) {
    return <UserNameCard email={email} mailLink className="cursor-default font-medium" />;
}

// Matches http(s) URLs, trimming trailing punctuation.
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
                    className="text-link hover:underline break-all"
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
    const contact = contacts.find((c) => c.email?.some((e) => e.toLowerCase() === target.toLowerCase()));

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

function InlineEdit({
    initialContent,
    onSave,
    onCancel,
}: {
    initialContent: string;
    onSave: (content: string) => void;
    onCancel: () => void;
}) {
    const [content, setContent] = useState(initialContent);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        const ta = textareaRef.current;
        if (ta) {
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
            ta.style.height = 'auto';
            ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
        }
    }, []);

    const handleSave = () => {
        const trimmed = content.trim();
        if (trimmed && trimmed !== initialContent) {
            onSave(trimmed);
        } else {
            onCancel();
        }
    };

    return (
        <div className="flex items-end gap-2">
            <textarea
                ref={textareaRef}
                value={content}
                onChange={(e) => {
                    setContent(e.target.value);
                    e.target.style.height = 'auto';
                    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSave();
                    }
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        onCancel();
                    }
                }}
                onBlur={() => {
                    if (content.trim() === initialContent) onCancel();
                }}
                rows={1}
                className="flex-1 min-w-0 resize-none rounded-lg border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring min-h-[40px] max-h-[120px] leading-[1.125]"
            />
            <TooltipButton icon={Check} tooltipText="Save" className="h-8 w-8" preventFocusLoss onClick={handleSave} />
            <TooltipButton icon={X} tooltipText="Cancel" className="h-8 w-8" preventFocusLoss onClick={onCancel} />
        </div>
    );
}

export function ChatMessageList({
    messages,
    isLoading,
    currentUserId,
    ownerId,
    mountId,
    mediaFolderId,
    className,
    emptyMessage = 'No messages yet. Start the conversation!',
    hasOlderMessages,
    isFetchingOlderMessages,
    onLoadMore,
    onEditMessage,
    onDeleteMessage,
    editingMessageId,
    onSaveEdit,
    onCancelEdit,
}: ChatMessageListProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const lastMessageIdRef = useRef('');
    const isInitialLoadRef = useRef(true);
    const { findByName } = useFolderLookup(ownerId ?? '', mountId ?? '', mediaFolderId ?? '');
    const copyFiles = useCopyFiles(ownerId ?? '', mountId ?? '');

    // Single floating action bar — tracks which message is hovered
    const [hoveredMsg, setHoveredMsg] = useState<{ message: ChatMessage; top: number } | null>(null);
    const [saveAttachmentsMsg, setSaveAttachmentsMsg] = useState<ChatMessage | null>(null);

    const handleMsgMouseEnter = useCallback(
        (message: ChatMessage, el: HTMLElement) => {
            if (message.type === 'system') return;
            const isOwn = message.authorId === currentUserId;
            const hasAttachments = !!message.attachments?.length;
            if (!isOwn && !hasAttachments) return;
            setHoveredMsg({ message, top: el.offsetTop });
        },
        [currentUserId],
    );

    const downloadTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
    useEffect(() => () => downloadTimers.current.forEach(clearTimeout), []);

    const handleDownloadLocally = useCallback(() => {
        if (!saveAttachmentsMsg?.attachments || !ownerId || !mountId) return;
        downloadTimers.current.forEach(clearTimeout);
        downloadTimers.current = [];
        saveAttachmentsMsg.attachments
            .filter((a): a is string => typeof a === 'string')
            .forEach((name, i) => {
                const fileInfo = findByName(name);
                if (fileInfo) {
                    downloadTimers.current.push(
                        setTimeout(() => {
                            const a = document.createElement('a');
                            a.href = getDriveDownloadUrl(ownerId, mountId, fileInfo.id, fileInfo.updatedAt);
                            a.download = '';
                            document.body.appendChild(a);
                            a.click();
                            a.remove();
                        }, i * 300),
                    );
                }
            });
        setSaveAttachmentsMsg(null);
    }, [saveAttachmentsMsg, ownerId, mountId, findByName]);

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

    // Auto-scroll when a new message appears at the end. Near-bottom is tracked from scroll
    // events (wasNearBottomRef): measuring here would include the just-rendered message, so a
    // tall message would push the distance past the threshold and never scroll.
    const wasNearBottomRef = useRef(true);
    useEffect(() => {
        const lastMessage = messages[messages.length - 1];
        const lastId = lastMessage?.id ?? '';
        const prevLastId = lastMessageIdRef.current;
        lastMessageIdRef.current = lastId;

        if (!prevLastId || lastId === prevLastId) return;

        if (lastMessage?.authorId === currentUserId || wasNearBottomRef.current) {
            scrollToBottom();
        }
    }, [messages, currentUserId, scrollToBottom]);

    // Load more when scrolling near the top
    const onLoadMoreRef = useRef(onLoadMore);
    onLoadMoreRef.current = onLoadMore;

    const handleScroll = useCallback(() => {
        const container = scrollRef.current;
        if (!container) return;
        wasNearBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
        if (!onLoadMoreRef.current || !hasOlderMessages || isFetchingOlderMessages) return;
        if (container.scrollTop < 200) {
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

    const renderAttachments = (message: ChatMessage) => {
        if (!message.attachments || message.attachments.length === 0) return null;

        const fileNames = message.attachments.filter((a): a is string => typeof a === 'string');
        const references = message.attachments.filter(isAttachmentReference);

        if (fileNames.length === 0 && references.length === 0) return null;

        return (
            <div className="flex flex-wrap gap-2 mt-1">
                {ownerId &&
                    mountId &&
                    mediaFolderId &&
                    fileNames.map((name) => (
                        <AttachmentChip
                            key={name}
                            fileName={name}
                            ownerId={ownerId}
                            mountId={mountId}
                            mediaFolderId={mediaFolderId}
                            siblingFileNames={fileNames}
                        />
                    ))}
                {references.map((ref) => (
                    <ReferenceAttachmentChip key={ref.id} reference={ref} />
                ))}
            </div>
        );
    };

    if (messages.length === 0) {
        return (
            <div className={cn('flex items-center justify-center flex-1', className)}>
                <p className="text-sm text-muted-foreground">{emptyMessage}</p>
            </div>
        );
    }

    const hoveredIsOwn = hoveredMsg?.message.authorId === currentUserId;
    const hoveredHasFileAttachments = !!hoveredMsg?.message.attachments?.some((a) => typeof a === 'string');
    const showActionBar =
        hoveredMsg && (hoveredHasFileAttachments || (hoveredIsOwn && (onEditMessage || onDeleteMessage)));

    return (
        <div
            ref={scrollRef}
            className={cn('flex-1 overflow-y-auto relative', className)}
            onMouseLeave={() => setHoveredMsg(null)}
        >
            {showActionBar && hoveredMsg && (
                <div
                    className="absolute right-3 z-10 flex items-center rounded-md border bg-background shadow-sm"
                    style={{ top: hoveredMsg.top + 4 }}
                    onMouseEnter={() => setHoveredMsg(hoveredMsg)}
                >
                    {hoveredHasFileAttachments && ownerId && mountId && (
                        <TooltipButton
                            icon={Download}
                            tooltipText="Save attachments"
                            className="h-7 w-7"
                            preventFocusLoss
                            onClick={() => setSaveAttachmentsMsg(hoveredMsg.message)}
                        />
                    )}
                    {hoveredIsOwn && onEditMessage && (
                        <TooltipButton
                            icon={Pencil}
                            tooltipText="Edit"
                            className="h-7 w-7"
                            preventFocusLoss
                            onClick={() => onEditMessage(hoveredMsg.message)}
                        />
                    )}
                    {hoveredIsOwn && onDeleteMessage && (
                        <TooltipButton
                            icon={Trash2}
                            tooltipText="Delete"
                            className="h-7 w-7"
                            preventFocusLoss
                            onClick={() => onDeleteMessage(hoveredMsg.message)}
                        />
                    )}
                </div>
            )}
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
                if (isDeleted) return null;
                const isHovered = hoveredMsg?.message.id === message.id;
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
                            <div key={message.id} className="flex gap-3 app-gutter-x py-2">
                                <div className="w-9 shrink-0" />
                                <InspectCard target={target} />
                            </div>
                        );
                    }
                    return (
                        <div key={message.id} className="flex gap-3 app-gutter-x py-2">
                            <div className="w-9 shrink-0" />
                            <p className="text-sm text-muted-foreground italic whitespace-pre-wrap">
                                {message.content}
                            </p>
                        </div>
                    );
                }

                if (isEmote) {
                    return (
                        <div
                            key={message.id}
                            className={cn(
                                'flex gap-3 app-gutter-x hover:bg-muted/50 transition-colors',
                                grouped ? 'py-1' : 'pt-3',
                                isHovered && 'bg-muted/50',
                            )}
                            onMouseEnter={(e) => handleMsgMouseEnter(message, e.currentTarget)}
                        >
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
                                        <UserNameCard
                                            email={message.authorEmail}
                                            className="text-sm font-medium text-foreground"
                                        />
                                        <span className="text-xs text-muted-foreground">
                                            {formatDateTime(message.createdAt)}
                                        </span>
                                    </div>
                                )}
                                <RichContent
                                    text={message.content}
                                    className="text-sm text-muted-foreground italic whitespace-pre-wrap"
                                />
                                {renderAttachments(message)}
                            </div>
                        </div>
                    );
                }

                if (isWhisper) {
                    return (
                        <div
                            key={message.id}
                            className={cn(
                                'flex gap-3 app-gutter-x hover:bg-primary/10 transition-colors bg-primary/5',
                                grouped ? 'pt-0.5' : 'pt-3',
                                isHovered && 'bg-primary/10',
                            )}
                            onMouseEnter={(e) => handleMsgMouseEnter(message, e.currentTarget)}
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
                                        <UserNameCard
                                            email={message.authorEmail}
                                            className="text-sm font-medium text-foreground"
                                        />
                                        <span className="text-xs text-muted-foreground">
                                            {formatDateTime(message.createdAt)}
                                        </span>
                                        <span className="text-xs text-primary font-medium italic">whisper</span>
                                    </div>
                                )}
                                <RichContent
                                    text={message.content}
                                    className="text-sm text-muted-foreground italic whitespace-pre-wrap break-words"
                                />
                                {renderAttachments(message)}
                            </div>
                        </div>
                    );
                }

                return (
                    <div
                        key={message.id}
                        className={cn(
                            'flex gap-3 app-gutter-x hover:bg-muted/50 transition-colors',
                            grouped ? 'pt-0.5' : 'pt-3',
                            isHovered && 'bg-muted/50',
                        )}
                        onMouseEnter={(e) => handleMsgMouseEnter(message, e.currentTarget)}
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
                                    <UserNameCard
                                        email={message.authorEmail}
                                        className="text-sm font-medium text-foreground"
                                    />
                                    <span className="text-xs text-muted-foreground">
                                        {formatDateTime(message.createdAt)}
                                    </span>
                                    {message.editedAt && (
                                        <span className="text-xs text-muted-foreground">(edited)</span>
                                    )}
                                </div>
                            )}
                            {editingMessageId === message.id && onSaveEdit && onCancelEdit ? (
                                <InlineEdit
                                    initialContent={message.content}
                                    onSave={(content) => onSaveEdit(message.id, content)}
                                    onCancel={onCancelEdit}
                                />
                            ) : (
                                <>
                                    <RichContent
                                        text={message.content}
                                        className="text-sm text-foreground whitespace-pre-wrap break-words"
                                    />
                                    {renderAttachments(message)}
                                </>
                            )}
                        </div>
                    </div>
                );
            })}
            <div className="h-3" />
            {ownerId && (
                <DriveLocationPicker
                    open={!!saveAttachmentsMsg}
                    onOpenChange={(open) => {
                        if (!open) setSaveAttachmentsMsg(null);
                    }}
                    mode="folder"
                    title="Save attachments"
                    confirmLabel="Save here"
                    defaultOwnerId={ownerId}
                    defaultMountId={mountId}
                    onConfirm={(location) => {
                        if (!saveAttachmentsMsg?.attachments) return;
                        const pathIds = saveAttachmentsMsg.attachments
                            .filter((a): a is string => typeof a === 'string')
                            .map((name) => findByName(name)?.id)
                            .filter((id): id is string => !!id);
                        if (pathIds.length === 0) return;
                        return copyFiles.mutateAsync({
                            pathIds,
                            targetOwnerId: location.ownerId,
                            targetMountId: location.mountId,
                            targetParentId: location.folderId,
                        });
                    }}
                    onDownloadInstead={handleDownloadLocally}
                />
            )}
        </div>
    );
}
