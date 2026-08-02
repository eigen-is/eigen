import { useVirtualizer } from '@tanstack/react-virtual';
import { formatDateTime } from '@workspace/lib/date';
import type { EmailSummary, MaildirMailbox } from '@workspace/lib/types/mail';
import { EmptyState, ErrorState, LoadingState, Toolbar } from '@workspace/ui';
import { ContextMenuAnchor, useContextMenu } from '@workspace/ui/components/layout/context-menu';
import { SearchBar } from '@workspace/ui/components/layout/search-bar/search-bar';
import { useListDrag } from '@workspace/ui/hooks/use-list-drag';
import type { UseListSelectionReturn } from '@workspace/ui/hooks/use-list-selection';
import { useLongPress } from '@workspace/ui/hooks/use-long-press';
import { cn } from '@workspace/ui/lib/utils';
import { Paperclip, Star } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { EmailContextMenu } from './email-context-menu';

type EmailListToolbarProps = {
    searchQuery: string;
    onSearchChange: (query: string) => void;
    // Handle for the `/` shortcut to focus the search input.
    inputRef?: React.RefObject<HTMLInputElement | null>;
};

export function EmailListToolbar({ searchQuery, onSearchChange, inputRef }: EmailListToolbarProps) {
    return (
        <Toolbar>
            <SearchBar
                placeholder="Search emails..."
                value={searchQuery}
                onChange={onSearchChange}
                maxWidth="full"
                inputClassName="h-8 bg-background"
                inputRef={inputRef}
            />
        </Toolbar>
    );
}

type EmailListProps = {
    // Controlled by MailRoute via useMailList — already filtered + sorted.
    orderedEmails: EmailSummary[];
    selection: UseListSelectionReturn<EmailSummary>;
    cursorIndex: number;
    setCursorIndex: (index: number) => void;
    onRowClick: (emailId: string) => void;
    activeRowId?: string;
    isLoading?: boolean;
    error?: Error | null;
    // Changes when the list's view identity changes (mailbox switch or entering/leaving search);
    // EmailList snaps the virtualizer back to the top so its window can't stay desynced from a prior scroll.
    resetKey?: string;
    // Infinite-scroll paging: fetch the next page as the cursor/scroll nears the loaded end.
    hasMore?: boolean;
    isFetchingMore?: boolean;
    onLoadMore?: () => void;
    onReply?: (emailId: string) => void;
    onReplyAll?: (emailId: string) => void;
    onForward?: (emailId: string) => void;
    onArchive?: (emailIds: string[]) => void;
    onReportSpam?: (emailIds: string[]) => void;
    onDelete?: (emailIds: string[]) => void;
    onMoveToFolder?: (emailIds: string[], folderId: string) => void;
    mailboxes?: MaildirMailbox[];
    currentFolderId?: string;
};

export function EmailList({
    orderedEmails,
    selection,
    cursorIndex,
    setCursorIndex,
    isLoading,
    error,
    resetKey,
    hasMore,
    isFetchingMore,
    onLoadMore,
    activeRowId,
    onRowClick,
    onReply,
    onReplyAll,
    onForward,
    onArchive,
    onReportSpam,
    onDelete,
    onMoveToFolder,
    mailboxes = [],
    currentFolderId = '',
}: EmailListProps) {
    const contextMenu = useContextMenu<EmailSummary>();
    const tableRef = useRef<HTMLDivElement>(null);

    // Estimate only — every row is measured, since a long sender line can wrap to a second row.
    const ROW_HEIGHT = 77;
    const virtualizer = useVirtualizer({
        count: orderedEmails.length,
        getScrollElement: () => tableRef.current,
        estimateSize: () => ROW_HEIGHT,
        // Key the measurement cache by id so a re-sort/filter moves cached heights with their row.
        getItemKey: (index) => orderedEmails[index].id,
        overscan: 12,
        // No scrollMargin: the search toolbar lives outside this scroller, so rows start at offset 0.
    });
    const virtualItems = virtualizer.getVirtualItems();

    // Keep the keyboard cursor in view. Replaces the shared hook's scrollToRow —
    // fires on cursor moves (arrows) and when an opened row syncs the cursor.
    useEffect(() => {
        if (cursorIndex >= 0) virtualizer.scrollToIndex(cursorIndex);
    }, [cursorIndex, virtualizer]);

    // Snap to the top when the view identity changes (mailbox switch or a change to the search query).
    // Under a scrolled position a drastic orderedEmails size change otherwise leaves the virtual window
    // desynced from the scroll offset (blank list until you nudge the scroll). The reset must land on
    // the NEW rows, not during the fetch gap: search swaps the results in place (the scroller stays
    // mounted), so firing scrollToOffset(0) while the list is momentarily empty doesn't stick once the
    // incoming rows mount. So arm on the resetKey change and perform it on the first render that has
    // rows — a plain scrollTop reset on the container the virtualizer then follows.
    const lastResetKey = useRef(resetKey);
    const pendingScrollReset = useRef(false);
    if (lastResetKey.current !== resetKey) {
        lastResetKey.current = resetKey;
        pendingScrollReset.current = true;
    }
    useEffect(() => {
        if (pendingScrollReset.current && orderedEmails.length > 0) {
            pendingScrollReset.current = false;
            tableRef.current?.scrollTo({ top: 0 });
        }
    }, [orderedEmails]);

    // Load the next page once the last rendered row nears the loaded end — covers scroll AND
    // j/k, since the keyboard cursor's scrollToIndex renders the end rows.
    useEffect(() => {
        const last = virtualItems[virtualItems.length - 1];
        if (last && hasMore && !isFetchingMore && last.index >= orderedEmails.length - 1 - 6) {
            onLoadMore?.();
        }
    }, [virtualItems, hasMore, isFetchingMore, orderedEmails.length, onLoadMore]);

    // Auto-focus the scroller shortly after mount so arrows work without a click —
    // reproduces use-keyboard-list-navigation.ts (54-61). Skip if focus already landed inside.
    useEffect(() => {
        const timer = setTimeout(() => {
            if (tableRef.current && !tableRef.current.contains(document.activeElement)) {
                tableRef.current.focus({ preventScroll: true });
            }
        }, 100);
        return () => clearTimeout(timer);
    }, []);

    const drag = useListDrag({ selection, getId: (e) => e.id, dragType: 'email' });

    // Mail-local keyboard nav, reproducing use-keyboard-list-navigation.ts for mail
    // (columns=1, no onQuickLook, no onDelete). Arrows scroll via the effect above;
    // Enter/Space/Home/End scroll explicitly since the cursor may not move.
    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (orderedEmails.length === 0) return;

        if ((e.key === 'a' || e.key === 'A') && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            selection.selectAll();
            return;
        }

        if (e.key === 'Escape') {
            e.preventDefault();
            selection.clearSelection();
            return;
        }

        const moveTo = (next: number) => {
            e.preventDefault();
            if (next >= 0 && next !== cursorIndex) {
                const id = orderedEmails[next].id;
                if (e.shiftKey) selection.selectRange(id);
                else selection.select(id);
                if (!e.shiftKey) onRowClick(id);
                setCursorIndex(next);
            }
        };

        switch (e.key) {
            case 'ArrowDown':
                // From no cursor, Down enters at the first row.
                moveTo(cursorIndex < 0 ? 0 : Math.min(cursorIndex + 1, orderedEmails.length - 1));
                break;

            case 'ArrowUp':
                moveTo(Math.max(cursorIndex - 1, 0));
                break;

            case ' ':
            case 'Enter':
                e.preventDefault();
                if (cursorIndex >= 0 && cursorIndex < orderedEmails.length) {
                    onRowClick(orderedEmails[cursorIndex].id);
                    virtualizer.scrollToIndex(cursorIndex);
                }
                break;

            case 'Delete':
                // Mail never wired a keyboard delete into the shared hook; preserve the
                // no-op (it still swallowed the key). Batch delete stays on the context menu.
                e.preventDefault();
                break;

            case 'PageUp':
            case 'Home':
                e.preventDefault();
                setCursorIndex(0);
                selection.select(orderedEmails[0].id);
                onRowClick(orderedEmails[0].id);
                virtualizer.scrollToIndex(0);
                break;

            case 'PageDown':
            case 'End': {
                e.preventDefault();
                const lastIndex = orderedEmails.length - 1;
                setCursorIndex(lastIndex);
                selection.select(orderedEmails[lastIndex].id);
                onRowClick(orderedEmails[lastIndex].id);
                virtualizer.scrollToIndex(lastIndex);
                break;
            }
        }
    };

    const handleContextMenu = (e: React.MouseEvent, email: EmailSummary) => {
        if (!selection.isSelected(email.id)) {
            selection.select(email.id);
        }
        contextMenu.handleContextMenu(e, email);
    };

    // Long-press opens the same menu on touch. Rows are mapped inline (no per-row component to hang a
    // hook on), so one list-level useLongPress reads the pressed row from a ref set on pointerdown.
    const pressedEmail = useRef<EmailSummary | null>(null);
    const openMenuAt = contextMenu.openAt;
    const handleLongPress = useCallback(
        (x: number, y: number) => {
            const email = pressedEmail.current;
            if (!email) return;
            if (!selection.isSelected(email.id)) {
                selection.select(email.id);
            }
            openMenuAt(email, x, y);
        },
        [selection, openMenuAt],
    );
    const longPress = useLongPress(handleLongPress);

    const contextIds = contextMenu.item
        ? selection.selectedCount > 1
            ? selection.selectedItems.map((e) => e.id)
            : [contextMenu.item.id]
        : [];
    const isSingleSelect = contextIds.length === 1;

    if (isLoading) {
        return <LoadingState />;
    }

    if (error) {
        return <ErrorState message="Could not load emails." detail={error.message} />;
    }

    return (
        <div className="w-full h-full flex flex-col overflow-hidden bg-background">
            <div className="flex-1 overflow-y-auto outline-none" tabIndex={0} onKeyDown={handleKeyDown} ref={tableRef}>
                {orderedEmails.length > 0 ? (
                    <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                        {virtualItems.map((vi) => {
                            const email = orderedEmails[vi.index];
                            const index = vi.index;
                            const formattedDate = email.date ? formatDateTime(email.date) : '';
                            const isOpen = activeRowId === email.id;

                            return (
                                <div
                                    key={email.id}
                                    data-index={index}
                                    ref={virtualizer.measureElement}
                                    className="absolute inset-x-0 top-0"
                                    style={{ transform: `translateY(${vi.start}px)` }}
                                >
                                    <div
                                        className={cn(
                                            'flex items-start gap-2.5 py-2 pl-4 pr-3 eigen-list-item',
                                            index > 0 && 'border-t border-border',
                                            // Open row: full active treatment (stripe + wash).
                                            isOpen && 'eigen-list-item-active',
                                            // Keyboard cursor on a different row: stripe only.
                                            !isOpen && cursorIndex === index && 'eigen-list-item-cursor',
                                            selection.isSelected(email.id) && 'eigen-list-item-selected',
                                        )}
                                        onClick={(e) => {
                                            selection.handleItemClick(email.id, e);
                                            if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                                                onRowClick(email.id);
                                            }
                                        }}
                                        onContextMenu={(e) => handleContextMenu(e, email)}
                                        onPointerDown={(e) => {
                                            pressedEmail.current = email;
                                            longPress.onPointerDown(e);
                                        }}
                                        onPointerMove={longPress.onPointerMove}
                                        onPointerUp={longPress.onPointerUp}
                                        onPointerCancel={longPress.onPointerCancel}
                                        onClickCapture={longPress.onClickCapture}
                                        {...drag.getDragProps(email)}
                                    >
                                        {/* Reserved dot gutter — fixed width so read/unread rows don't shift. */}
                                        <div className="w-1.5 shrink-0 mt-2">
                                            {!email.isRead && (
                                                <span
                                                    aria-hidden
                                                    className="block h-1.5 w-1.5 rounded-full"
                                                    style={{ backgroundColor: 'var(--app-current-color)' }}
                                                />
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            {/* items-center (not items-baseline): the flag star is a non-text child, and
                                                under baseline alignment its presence shifts the date up. Centering keeps
                                                the date fixed whether or not the row is starred. */}
                                            <div className="flex justify-between items-center">
                                                <div
                                                    className={cn(
                                                        'text-sm font-medium text-foreground',
                                                        !email.isRead && 'font-semibold',
                                                    )}
                                                >
                                                    {email.fromShort || 'Unknown'}
                                                </div>
                                                <div className="flex items-center gap-1 ml-2 shrink-0">
                                                    {email.isFlagged && (
                                                        // Match the date's text size so a flagged row doesn't grow the
                                                        // line box and nudge the date up (the row aligns to baseline).
                                                        <Star
                                                            aria-hidden
                                                            className="h-3 w-3 shrink-0 fill-current"
                                                            style={{ color: 'var(--app-current-color)' }}
                                                        />
                                                    )}
                                                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                                                        {formattedDate}
                                                    </span>
                                                </div>
                                            </div>
                                            <div
                                                className={cn(
                                                    'text-sm truncate mt-0.5 text-foreground',
                                                    !email.isRead && 'font-medium',
                                                )}
                                            >
                                                {email.subject}
                                            </div>
                                            <div className="text-xs truncate text-muted-foreground mt-0.5 flex items-center">
                                                <span className="truncate">{email.textShort}</span>
                                                {email.hasAttachments && (
                                                    <Paperclip className="h-3 w-3 ml-1 shrink-0 text-muted-foreground" />
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <EmptyState message="No emails found" />
                )}
            </div>

            <ContextMenuAnchor contextMenu={contextMenu} className="w-56">
                <EmailContextMenu
                    messageIds={contextIds}
                    isSingleSelect={isSingleSelect}
                    mailboxes={mailboxes}
                    currentMailboxId={currentFolderId}
                    onReply={onReply}
                    onReplyAll={onReplyAll}
                    onForward={onForward}
                    onArchive={onArchive}
                    onReportSpam={onReportSpam}
                    onDelete={onDelete}
                    onMoveToFolder={onMoveToFolder}
                    onClose={contextMenu.close}
                />
            </ContextMenuAnchor>
        </div>
    );
}
