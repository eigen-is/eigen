import { getDriveDownloadUrl } from '@workspace/lib/api';
import { formatDateTime } from '@workspace/lib/date';
import { useCopyFiles, useFolderLookup } from '@workspace/lib/drive';
import type { ChatMessage } from '@workspace/lib/types/chat';
import { isAttachmentReference } from '@workspace/lib/types/chat';
import { UserNameCard } from '@workspace/ui/components/user/user-name-card';
import { Download, Pencil, Trash2 } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLongPress } from '../../hooks/use-long-press';
import { cn } from '../../lib/utils';
import { AttachmentChip } from '../attachment/attachment-chip';
import { ReferenceAttachmentChip } from '../attachment/reference-attachment-chip';
import { EigenLoader } from '../braket/eigen-loader';
import { ContextMenuAnchor, useContextMenu } from '../context-menu';
import { DriveLocationPicker } from '../drive/drive-location-picker';
import { DropdownMenuItem } from '../dropdown-menu';
import { LoadingState } from '../layout/app/loading-state';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { UserAvatar } from '../user/user-avatar';
import { InlineEdit } from './inline-edit';
import { InspectCard } from './inspect-card';
import { RichContent } from './rich-content';

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

    const [saveAttachmentsMsg, setSaveAttachmentsMsg] = useState<ChatMessage | null>(null);

    // Message actions (Save attachments / Edit / Delete) reach the singleton context menu via right-click and touch long-press.
    const contextMenu = useContextMenu<ChatMessage>();
    const openMenuAt = contextMenu.openAt;
    const handleLongPress = useCallback(
        (message: ChatMessage, x: number, y: number) => {
            openMenuAt(message, x, y);
        },
        [openMenuAt],
    );
    const longPress = useLongPress(handleLongPress);

    // One gating source shared by the hover bar and the context menu so the two action sets never drift.
    const getMessageActions = useCallback(
        (message: ChatMessage) => {
            const isOwn = message.authorId === currentUserId;
            const hasFileAttachments = !!message.attachments?.some((a) => typeof a === 'string');
            return {
                canSaveAttachments: hasFileAttachments && !!ownerId && !!mountId,
                canEdit: isOwn && !!onEditMessage,
                canDelete: isOwn && !!onDeleteMessage,
            };
        },
        [currentUserId, ownerId, mountId, onEditMessage, onDeleteMessage],
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

    const menuMessage = contextMenu.item;
    const menuActions = menuMessage ? getMessageActions(menuMessage) : null;

    return (
        <div ref={scrollRef} className={cn('flex-1 overflow-y-auto relative', className)}>
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

                const actions = getMessageActions(message);
                const hasActions = actions.canSaveAttachments || actions.canEdit || actions.canDelete;
                const actionProps = hasActions
                    ? {
                          onContextMenu: (e: React.MouseEvent) => {
                              // Leave links and selected text to the browser's native copy menu.
                              const selection = window.getSelection();
                              if ((e.target as HTMLElement).closest('a') || (selection && !selection.isCollapsed))
                                  return;
                              contextMenu.handleContextMenu(e, message);
                          },
                          ...longPress.bind(message),
                      }
                    : {};
                // Desktop-only hover affordance (fine pointer); touch has none — long-press opens the same menu.
                const hoverActions = hasActions ? (
                    <div className="absolute right-2 top-1 z-10 flex items-center rounded-md border bg-background shadow-sm invisible pointer-fine:group-hover:visible">
                        {actions.canSaveAttachments && (
                            <TooltipButton
                                icon={Download}
                                tooltipText="Save attachments"
                                className="h-7 w-7"
                                preventFocusLoss
                                onClick={() => setSaveAttachmentsMsg(message)}
                            />
                        )}
                        {actions.canEdit && onEditMessage && (
                            <TooltipButton
                                icon={Pencil}
                                tooltipText="Edit"
                                className="h-7 w-7"
                                preventFocusLoss
                                onClick={() => onEditMessage(message)}
                            />
                        )}
                        {actions.canDelete && onDeleteMessage && (
                            <TooltipButton
                                icon={Trash2}
                                tooltipText="Delete"
                                className="h-7 w-7"
                                preventFocusLoss
                                onClick={() => onDeleteMessage(message)}
                            />
                        )}
                    </div>
                ) : null;

                if (isEmote) {
                    return (
                        <div
                            key={message.id}
                            className={cn(
                                'group relative flex gap-3 app-gutter-x hover:bg-muted/50 transition-colors',
                                grouped ? 'py-1' : 'pt-3',
                            )}
                            {...actionProps}
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
                            {hoverActions}
                        </div>
                    );
                }

                if (isWhisper) {
                    return (
                        <div
                            key={message.id}
                            className={cn(
                                'group relative flex gap-3 app-gutter-x hover:bg-primary/10 transition-colors bg-primary/5',
                                grouped ? 'pt-0.5' : 'pt-3',
                            )}
                            {...actionProps}
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
                            {hoverActions}
                        </div>
                    );
                }

                return (
                    <div
                        key={message.id}
                        className={cn(
                            'group relative flex gap-3 app-gutter-x hover:bg-muted/50 transition-colors',
                            grouped ? 'pt-0.5' : 'pt-3',
                        )}
                        {...actionProps}
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
                        {hoverActions}
                    </div>
                );
            })}
            <div className="h-3" />
            <ContextMenuAnchor contextMenu={contextMenu} className="min-w-[180px]">
                {menuMessage && (
                    <>
                        {menuActions?.canSaveAttachments && (
                            <DropdownMenuItem
                                onClick={() => {
                                    setSaveAttachmentsMsg(menuMessage);
                                    contextMenu.close();
                                }}
                            >
                                <Download className="h-4 w-4 mr-2" /> Save attachments
                            </DropdownMenuItem>
                        )}
                        {menuActions?.canEdit && onEditMessage && (
                            <DropdownMenuItem
                                onClick={() => {
                                    onEditMessage(menuMessage);
                                    contextMenu.close();
                                }}
                            >
                                <Pencil className="h-4 w-4 mr-2" /> Edit
                            </DropdownMenuItem>
                        )}
                        {menuActions?.canDelete && onDeleteMessage && (
                            <DropdownMenuItem
                                variant="destructive"
                                onClick={() => {
                                    onDeleteMessage(menuMessage);
                                    contextMenu.close();
                                }}
                            >
                                <Trash2 className="h-4 w-4 mr-2" /> Delete
                            </DropdownMenuItem>
                        )}
                    </>
                )}
            </ContextMenuAnchor>
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
                    onConfirm={async (location) => {
                        if (!saveAttachmentsMsg?.attachments) return;
                        const pathIds = saveAttachmentsMsg.attachments
                            .filter((a): a is string => typeof a === 'string')
                            .map((name) => findByName(name)?.id)
                            .filter((id): id is string => !!id);
                        if (pathIds.length === 0) return;
                        await copyFiles.mutateAsync({
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
