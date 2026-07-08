import { useVirtualizer } from '@tanstack/react-virtual';
import { formatDateTime } from '@workspace/lib/date';
import type { EmailSummary, MaildirMailbox } from '@workspace/lib/types/mail';
import { EmptyState, ErrorState, LoadingState, Toolbar } from '@workspace/ui';
import { ContextMenuAnchor, useContextMenu } from '@workspace/ui/components/layout/context-menu';
import { SearchBar } from '@workspace/ui/components/layout/search-bar/search-bar';
import { useKeyboardListNavigation } from '@workspace/ui/hooks/use-keyboard-list-navigation';
import { useListDrag } from '@workspace/ui/hooks/use-list-drag';
import { useListSelection } from '@workspace/ui/hooks/use-list-selection';
import { cn } from '@workspace/ui/lib/utils';
import { Paperclip } from 'lucide-react';
import { useMemo, useRef } from 'react';
import { EmailContextMenu } from './email-context-menu';

type EmailListToolbarProps = {
    searchQuery: string;
    onSearchChange: (query: string) => void;
};

export function EmailListToolbar({ searchQuery, onSearchChange }: EmailListToolbarProps) {
    return (
        <Toolbar>
            <SearchBar
                placeholder="Search emails..."
                value={searchQuery}
                onChange={onSearchChange}
                maxWidth="full"
                inputClassName="h-8 bg-background"
            />
        </Toolbar>
    );
}

type EmailListProps = {
    emails: EmailSummary[];
    searchQuery: string;
    onRowClick: (emailId: string) => void;
    activeRowId?: string;
    isLoading?: boolean;
    error?: Error | null;
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
    emails,
    searchQuery,
    isLoading,
    error,
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

    const filteredEmails = useMemo(() => {
        const queryLower = searchQuery.toLowerCase();
        return [...emails]
            .filter(
                (email) =>
                    email.subject.toLowerCase().includes(queryLower) ||
                    email.fromShort.toLowerCase().includes(queryLower) ||
                    email.textShort.toLowerCase().includes(queryLower),
            )
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    }, [emails, searchQuery]);

    const selection = useListSelection({ items: filteredEmails, getId: (e) => e.id });

    // Estimate only — every row is measured, since a long sender line can wrap to a second row.
    const ROW_HEIGHT = 77;
    const virtualizer = useVirtualizer({
        count: filteredEmails.length,
        getScrollElement: () => tableRef.current,
        estimateSize: () => ROW_HEIGHT,
        // Key the measurement cache by id so a re-sort/filter moves cached heights with their row.
        getItemKey: (index) => filteredEmails[index].id,
        overscan: 12,
        // No scrollMargin: the search toolbar lives outside this scroller, so rows start at offset 0.
    });

    const { selectedIndex, handleKeyDown } = useKeyboardListNavigation({
        items: filteredEmails,
        activeId: activeRowId,
        getId: (email) => email.id,
        onSelect: onRowClick,
        containerRef: tableRef,
        selection,
        scrollToIndex: virtualizer.scrollToIndex,
    });

    const drag = useListDrag({ selection, getId: (e) => e.id, dragType: 'email' });

    const handleContextMenu = (e: React.MouseEvent, email: EmailSummary) => {
        if (!selection.isSelected(email.id)) {
            selection.select(email.id);
        }
        contextMenu.handleContextMenu(e, email);
    };

    const contextIds = contextMenu.item
        ? selection.selectedCount > 1
            ? selection.selectedItems.map((e) => e.id)
            : [contextMenu.item.id]
        : [];
    const isSingleSelect = contextIds.length === 1;

    if (isLoading || !emails) {
        return <LoadingState />;
    }

    if (error) {
        return <ErrorState message="Could not load emails." detail={error.message} />;
    }

    return (
        <div className="w-full h-full flex flex-col overflow-hidden bg-background">
            <div className="flex-1 overflow-y-auto outline-none" tabIndex={0} onKeyDown={handleKeyDown} ref={tableRef}>
                {filteredEmails.length > 0 ? (
                    <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                        {virtualizer.getVirtualItems().map((vi) => {
                            const email = filteredEmails[vi.index];
                            const index = vi.index;
                            const formattedDate = email.date ? formatDateTime(email.date) : '';

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
                                            (activeRowId === email.id || selectedIndex === index) &&
                                                'eigen-list-item-active',
                                            selection.isSelected(email.id) && 'eigen-list-item-selected',
                                        )}
                                        onClick={(e) => {
                                            selection.handleItemClick(email.id, e);
                                            if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                                                onRowClick(email.id);
                                            }
                                        }}
                                        onContextMenu={(e) => handleContextMenu(e, email)}
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
                                            <div className="flex justify-between items-baseline">
                                                <div
                                                    className={cn(
                                                        'text-sm font-medium text-foreground',
                                                        !email.isRead && 'font-semibold',
                                                    )}
                                                >
                                                    {email.fromShort || 'Unknown'}
                                                </div>
                                                <div className="text-xs text-muted-foreground whitespace-nowrap ml-2">
                                                    {formattedDate}
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
