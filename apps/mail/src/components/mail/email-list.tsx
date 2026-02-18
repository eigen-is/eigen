import {Paperclip} from "lucide-react";
import {useMemo, useRef} from "react";
import {cn} from "@workspace/ui/lib/utils";
import {SearchBar} from "@workspace/ui/components/layout/search-bar/search-bar";
import {EigenLoader} from "@workspace/ui/components/layout/eigen-loader";
import {EmailSummary, MaildirMailbox} from "@workspace/lib/types/mail";
import {EmailContextMenu} from "./email-context-menu";
import {ContextMenuAnchor} from "@workspace/ui/components/layout/context-menu";
import {useContextMenu} from "@workspace/ui/components/layout/context-menu";
import {useKeyboardListNavigation} from "@workspace/ui/hooks/use-keyboard-list-navigation";
import {useListSelection} from "@workspace/ui/hooks/use-list-selection";
import {useListDrag} from "@workspace/ui/hooks/use-list-drag";

interface EmailListToolbarProps {
    searchQuery: string;
    onSearchChange: (query: string) => void;
}

export function EmailListToolbar({searchQuery, onSearchChange}: EmailListToolbarProps) {
    return (
        <SearchBar
            placeholder="Search emails..."
            value={searchQuery}
            onChange={onSearchChange}
            maxWidth="full"
            inputClassName="h-8 bg-white"
        />
    );
}

interface EmailListProps {
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
}

export function EmailList({
                              emails,
                              searchQuery,
                              isLoading,
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
                              currentFolderId = ""
                          }: EmailListProps) {
    const contextMenu = useContextMenu<EmailSummary>();
    const tableRef = useRef<HTMLDivElement>(null);

    const filteredEmails = useMemo(() => {
        const queryLower = searchQuery.toLowerCase();
        return [...emails].filter(email => email.subject.toLowerCase().includes(queryLower) || email.fromShort.toLowerCase().includes(queryLower) || email.textShort.toLowerCase().includes(queryLower)).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    }, [emails, searchQuery]);

    const selection = useListSelection({items: filteredEmails, getId: (e) => e.id});

    const {selectedIndex, handleKeyDown} = useKeyboardListNavigation({
        items: filteredEmails,
        activeId: activeRowId,
        getId: (email) => email.id,
        onSelect: onRowClick,
        containerRef: tableRef,
        selection,
    });

    const drag = useListDrag({selection, getId: (e) => e.id, dragType: 'email'});

    const handleContextMenu = (e: React.MouseEvent, email: EmailSummary) => {
        if (!selection.isSelected(email.id)) {
            selection.select(email.id);
        }
        contextMenu.handleContextMenu(e, email);
    };

    const contextIds = contextMenu.item
        ? (selection.selectedCount > 1 ? selection.selectedItems.map(e => e.id) : [contextMenu.item.id])
        : [];
    const isSingleSelect = contextIds.length === 1;

    if (isLoading || !emails) {
        return (
            <div className="flex h-full items-center justify-center">
                <EigenLoader/>
            </div>
        );
    }

    return (
        <div className="w-full h-full flex flex-col overflow-hidden bg-white">
            <div
                className="flex-1 overflow-y-auto outline-none"
                tabIndex={0}
                onKeyDown={handleKeyDown}
                ref={tableRef}
            >
                <div className="w-full">
                    {filteredEmails.length > 0 ? (
                        <div className="divide-y divide-gray-100">
                            {filteredEmails.map((email, index) => {
                                let formattedDate = '';
                                if (email.date) {
                                    const date = new Date(email.date);
                                    const now = new Date();
                                    const isToday = date.toDateString() === now.toDateString();
                                    if (isToday) {
                                        formattedDate = date.toLocaleTimeString([], {
                                            hour: '2-digit',
                                            minute: '2-digit'
                                        });
                                    } else {
                                        formattedDate = date.toLocaleDateString([], {month: 'short', day: 'numeric'});
                                    }
                                }

                                return (
                                    <div
                                        key={email.id}
                                        className={cn(
                                            "flex items-start py-2 px-3 eigen-list-item",
                                            (activeRowId === email.id || selectedIndex === index) && "eigen-list-item-active",
                                            selection.isSelected(email.id) && "eigen-list-item-selected",
                                            !email.isRead && activeRowId !== email.id && selectedIndex !== index && !selection.isSelected(email.id) && "eigen-list-item-unread"
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
                                        <div className="flex-1 min-w-0">
                                            <div className="flex justify-between items-baseline">
                                                <div className={cn(
                                                    "text-sm font-medium text-gray-900",
                                                    !email.isRead && "font-semibold"
                                                )}>
                                                    {email.fromShort || 'Unknown'}
                                                </div>
                                                <div className="text-xs text-gray-500 whitespace-nowrap ml-2">
                                                    {formattedDate}
                                                </div>
                                            </div>
                                            <div className={cn(
                                                "text-sm truncate mt-0.5 text-gray-700",
                                                !email.isRead && "font-medium"
                                            )}>
                                                {email.subject}
                                            </div>
                                            <div className="text-xs truncate text-gray-500 mt-0.5 flex items-center">
                                                <span className="truncate">{email.textShort}</span>
                                                {email.hasAttachments && (
                                                    <Paperclip className="h-3 w-3 ml-1 shrink-0 text-gray-400"/>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="h-24 flex items-center justify-center text-gray-500">
                            No emails found.
                        </div>
                    )}
                </div>
            </div>

            <ContextMenuAnchor isOpen={contextMenu.isOpen} onClose={contextMenu.close}>
                <EmailContextMenu
                    style={{
                        position: 'absolute',
                        top: `${contextMenu.position.y}px`,
                        left: `${contextMenu.position.x}px`,
                    }}
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
