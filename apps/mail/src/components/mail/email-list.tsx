// Mail's message list and the search toolbar above it. The list draws the messages of the open mailbox or search in a
// virtualized scroller and composes the shared list hooks: keyboard navigation, selection, drag and one context menu
// for every row. The mail route owns the order and the keyboard cursor and passes both in, so the shortcuts layer
// reads the same cursor.

import { useVirtualizer } from '@tanstack/react-virtual';
import { MAILBOX_SENT } from '@workspace/lib/constants/mailboxes';
import { formatDateTime } from '@workspace/lib/date';
import type { EmailSummary, MaildirMailbox } from '@workspace/lib/types/mail';
import { ContextMenuAnchor } from '@workspace/ui/components/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from '@workspace/ui/components/dropdown-menu';
import { EmptyState, ErrorState, LoadingState } from '@workspace/ui/components/layout/app';
import { KebabTrigger, Toolbar } from '@workspace/ui/components/layout/toolbar';
import { SearchBar } from '@workspace/ui/components/search-bar/search-bar';
import { UnreadDot } from '@workspace/ui/components/unread-dot';
import { useKeyboardListNavigation } from '@workspace/ui/hooks/use-keyboard-list-navigation';
import { useListDrag } from '@workspace/ui/hooks/use-list-drag';
import type { UseListSelectionReturn } from '@workspace/ui/hooks/use-list-selection';
import { useLongPress } from '@workspace/ui/hooks/use-long-press';
import { useSelectableContextMenu } from '@workspace/ui/hooks/use-selectable-context-menu';
import { cn } from '@workspace/ui/lib/utils';
import { Keyboard, Paperclip, Reply, Star } from 'lucide-react';
import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';
import { EmailContextMenu } from './email-context-menu';

type EmailListToolbarProps = {
    searchQuery: string;
    onSearchChange: (query: string) => void;
    // The `/` shortcut focuses the search field through this.
    inputRef?: RefObject<HTMLInputElement | null>;
    // Opens the shortcuts cheat sheet. The `?` key opens it only while the keyboard shortcuts setting is on, and it is
    // off by default. So this ⋮ is the one way to find the sheet, and it shows at every width.
    onShowShortcuts: () => void;
};

export function EmailListToolbar({ searchQuery, onSearchChange, inputRef, onShowShortcuts }: EmailListToolbarProps) {
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
            <DropdownMenu>
                <KebabTrigger />
                <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={onShowShortcuts}>
                        <Keyboard /> Keyboard shortcuts
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </Toolbar>
    );
}

type EmailListProps = {
    // The mail route holds these through useMailList, already filtered and sorted.
    orderedEmails: EmailSummary[];
    selection: UseListSelectionReturn<EmailSummary>;
    cursorIndex: number;
    setCursorIndex: (index: number) => void;
    onRowClick: (emailId: string) => void;
    activeRowId?: string;
    // True while the inline composer owns typing. The list then neither takes nor reclaims the focus, or the arrows
    // would switch conversations under a half-written reply. The shortcuts layer stands down on the same signal.
    isComposing?: boolean;
    isLoading?: boolean;
    error?: Error | null;
    // Changes when the list shows another view, such as another mailbox or a search that starts or ends. The list then
    // scrolls back to the top, so the virtualizer's window can't stay out of step with an old scroll position.
    resetKey?: string;
    // Paging: the list asks for the next page as the cursor or the scroll nears the end of what is loaded.
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
    isComposing,
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
    const tableRef = useRef<HTMLDivElement>(null);

    // An estimate only. Every row is measured, since a long sender line can wrap to a second line.
    const ROW_HEIGHT = 77;
    const virtualizer = useVirtualizer({
        count: orderedEmails.length,
        getScrollElement: () => tableRef.current,
        estimateSize: () => ROW_HEIGHT,
        // Key the measurement cache by id, so a new sort or filter moves the measured heights with their rows.
        getItemKey: (index) => orderedEmails[index].id,
        overscan: 12,
        // No scrollMargin. The search toolbar sits outside this scroller, so the rows start at offset 0.
    });
    const virtualItems = virtualizer.getVirtualItems();

    // Keep the keyboard cursor in view. Some code moves the cursor without the list's own key handler: j and k in the
    // shortcuts layer, and useMailList when it moves the cursor to an opened row.
    useEffect(() => {
        if (cursorIndex >= 0) virtualizer.scrollToIndex(cursorIndex);
    }, [cursorIndex, virtualizer]);

    // Scroll to the top when the view changes, such as another mailbox or another search. In a scrolled list, a big
    // change in the number of rows otherwise leaves the virtual window out of step with the scroll offset, and the list
    // shows blank until the user scrolls. The reset has to happen on the new rows, not while they load. A search swaps
    // its results in place and the scroller stays mounted, so a scroll to the top while the list is briefly empty
    // doesn't stick once the new rows mount. So a resetKey change only marks the reset, and the first render with rows
    // sets the container's scrollTop, which the virtualizer follows.
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

    // Load the next page once the last drawn row nears the end of what is loaded. This covers scrolling and j and k,
    // since the cursor's scrollToIndex draws the last rows.
    useEffect(() => {
        const last = virtualItems[virtualItems.length - 1];
        if (last && hasMore && !isFetchingMore && last.index >= orderedEmails.length - 1 - 6) {
            onLoadMore?.();
        }
    }, [virtualItems, hasMore, isFetchingMore, orderedEmails.length, onLoadMore]);

    const drag = useListDrag({ selection, getId: (e) => e.id, dragType: 'email' });

    // A right-click, a touch long-press and the menu key select the row, then open the one menu. The rows are drawn
    // inline, with no row component to call a hook in, so one useLongPress for the list carries the pressed row
    // through bind(email).
    const { contextMenu, handleContextMenu, openAt, openBelow } = useSelectableContextMenu({
        selection,
        getId: (e) => e.id,
    });
    const longPress = useLongPress(openAt);

    // The shared keyboard model, with the cursor lifted: the mail route owns it, tracked by id and shared with the
    // shortcuts layer, and the virtualizer scrolls. The hook also owns the list's focus. It takes the focus on mount and
    // takes it back from <body>, which keeps the shortcuts alive after a click on something that takes no focus. It
    // stands down while composing, so a reply keeps its keystrokes. There is no onDelete: Delete and Backspace live in
    // useMailShortcuts, which also covers an open conversation, and the list only swallows the key.
    const { handleKeyDown } = useKeyboardListNavigation({
        items: orderedEmails,
        getId: (e) => e.id,
        onSelect: onRowClick,
        containerRef: tableRef,
        selection,
        scrollToIndex: (index) => virtualizer.scrollToIndex(index),
        reclaimFocus: !isComposing,
        cursorIndex,
        onCursorChange: setCursorIndex,
        // The menu key opens the menu at the row, which carries the virtualizer's data-index. The hook scrolls a row
        // out of the window in and calls this a frame later, once the row is drawn. The list is only a fallback.
        onMenu: (email, index) => {
            const list = tableRef.current;
            const row = list?.querySelector(`[data-index="${index}"]`);
            const anchor = row instanceof HTMLElement ? row : list;
            if (anchor) openBelow(anchor, email);
        },
    });

    const contextIds = contextMenu.item
        ? selection.selectedItems.length > 1
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
                            // In Sent the sender is always the user, so the row names who it went to.
                            const correspondent = email.mailbox === MAILBOX_SENT ? email.toShort : email.fromShort;

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
                                            'relative flex items-start py-2 app-gutter-x eigen-list-item',
                                            index > 0 && 'border-t border-border',
                                            // The open row gets the full active look, stripe and wash.
                                            isOpen && 'eigen-list-item-active',
                                            // The keyboard cursor on another row gets the stripe only.
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
                                        {...longPress.bind(email)}
                                        {...drag.getDragProps(email)}
                                    >
                                        {/* Centered in the row's left gutter, so the text keeps the list's one left edge. */}
                                        {!email.isRead && (
                                            <span
                                                aria-hidden
                                                className="absolute left-0 top-3.5 flex w-(--app-gutter-x) justify-center"
                                            >
                                                <UnreadDot className="static bg-(--app-current-color)" />
                                            </span>
                                        )}
                                        <div className="flex-1 min-w-0">
                                            {/* items-center, not items-baseline: the star is no text, and under
                                                baseline alignment it shifts the date up. Centered, the date stays put
                                                whether or not the row is starred. */}
                                            <div className="flex justify-between items-center">
                                                <div
                                                    className={cn(
                                                        'text-sm font-medium text-foreground',
                                                        !email.isRead && 'font-semibold',
                                                    )}
                                                >
                                                    {correspondent || 'Unknown'}
                                                </div>
                                                <div className="flex items-center gap-1 ml-2 shrink-0">
                                                    {email.isReplied && (
                                                        <Reply
                                                            aria-hidden
                                                            className="h-3 w-3 shrink-0 text-muted-foreground"
                                                        />
                                                    )}
                                                    {email.isFlagged && (
                                                        // As tall as the date's text, so a flagged row's line grows
                                                        // no taller and the date stays put.
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
