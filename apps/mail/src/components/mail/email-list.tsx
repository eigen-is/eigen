import {Paperclip, Search} from "lucide-react";
import {KeyboardEvent, useEffect, useMemo, useRef, useState} from "react";
import {cn} from "@workspace/ui/lib/utils";
import {Input} from "@workspace/ui/components/input";
import {EigenLoader} from "@workspace/ui/components/layout/eigen-loader";
import {EmailSummary, MaildirMailbox} from "@workspace/lib/types/mail";
import {DropdownMenu, DropdownMenuTrigger,} from "@workspace/ui/components/dropdown-menu";
import {EmailContextMenu} from "./email-context-menu";

interface EmailListProps {
    emails: EmailSummary[];
    onRowClick: (emailId: string) => void;
    activeRowId?: string;
    isLoading?: boolean;
    error?: Error | null;
    onReply?: (emailId: string) => void;
    onReplyAll?: (emailId: string) => void;
    onForward?: (emailId: string) => void;
    onArchive?: (emailId: string) => void;
    onReportSpam?: (emailId: string) => void;
    onDelete?: (emailId: string) => void;
    onMoveToFolder?: (emailId: string, folderId: string) => void;
    mailboxes?: MaildirMailbox[];
    currentFolderId?: string;
}

export function EmailList({
                              emails,
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
    // State for filtering
    const [globalFilter, setGlobalFilter] = useState("");
    // State voor het bijhouden van de huidige geselecteerde index
    const [selectedIndex, setSelectedIndex] = useState<number>(-1);
    // State for the context menu
    const [contextMenuEmail, setContextMenuEmail] = useState<EmailSummary | null>(null);
    // State for the context menu position
    const [menuPosition, setMenuPosition] = useState({x: 0, y: 0});
    // Ref for the context menu
    const contextMenuRef = useRef<HTMLDivElement>(null);
    // Ref voor de tabel om naar geselecteerde rijen te kunnen scrollen
    const tableRef = useRef<HTMLDivElement>(null);

    // Helper functie om naar een specifieke rij te scrollen
    const scrollToRow = (index: number) => {
        if (tableRef.current) {
            const emailItems = tableRef.current.querySelectorAll('.eigen-list-item');
            if (emailItems[index]) {
                emailItems[index].scrollIntoView({
                    behavior: 'smooth',
                    block: 'nearest'
                });
            }
        }
    };

    // Gefilterde e-mails voor gebruik met toetsenbord navigatie
    const filteredEmails = useMemo(() => {
        const globalFilterLowerCase = globalFilter.toLowerCase();
        return [...emails].filter(email => email.subject.toLowerCase().includes(globalFilterLowerCase) || email.fromShort.toLowerCase().includes(globalFilterLowerCase) || email.textShort.toLowerCase().includes(globalFilterLowerCase)).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    }, [emails, globalFilter]);

    // Effect om selectedIndex bij te werken wanneer activeRowId verandert
    useEffect(() => {
        if (activeRowId && filteredEmails.length > 0) {
            const index = filteredEmails.findIndex(email => email.id === activeRowId);
            if (index !== -1) {
                setSelectedIndex(index);
            }
        } else {
            setSelectedIndex(-1);
        }
    }, [activeRowId, filteredEmails]);

    // Handel toetsenbord navigatie af
    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (filteredEmails.length === 0) return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setSelectedIndex(prev => {
                    const newIndex = Math.min(prev + 1, filteredEmails.length - 1);
                    if (newIndex >= 0) {
                        // Item selecteren
                        onRowClick(filteredEmails[newIndex].id);
                        // Scroll naar de geselecteerde rij
                        scrollToRow(newIndex);
                    }
                    return newIndex;
                });
                break;

            case 'ArrowUp':
                e.preventDefault();
                setSelectedIndex(prev => {
                    const newIndex = Math.max(prev - 1, 0);
                    if (newIndex >= 0) {
                        // Item selecteren
                        onRowClick(filteredEmails[newIndex].id);
                        // Scroll naar de geselecteerde rij
                        scrollToRow(newIndex);
                    }
                    return newIndex;
                });
                break;

            case 'Enter':
                e.preventDefault();
                if (selectedIndex >= 0 && selectedIndex < filteredEmails.length) {
                    onRowClick(filteredEmails[selectedIndex].id);
                    // Scroll naar de geselecteerde rij
                    scrollToRow(selectedIndex);
                }
                break;

            case 'Home':
                e.preventDefault();
                if (filteredEmails.length > 0) {
                    setSelectedIndex(0);
                    onRowClick(filteredEmails[0].id);
                    // Scroll naar de eerste rij
                    scrollToRow(0);
                }
                break;

            case 'End':
                e.preventDefault();
                if (filteredEmails.length > 0) {
                    const lastIndex = filteredEmails.length - 1;
                    setSelectedIndex(lastIndex);
                    onRowClick(filteredEmails[lastIndex].id);
                    // Scroll naar de laatste rij
                    scrollToRow(lastIndex);
                }
                break;
        }
    };

    // Handle right-click on email
    const handleContextMenu = (e: React.MouseEvent, email: EmailSummary) => {
        e.preventDefault();
        setContextMenuEmail(email);
        setMenuPosition({x: e.clientX, y: e.clientY});
    };

    // Close context menu when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
                setContextMenuEmail(null);
            }
        };

        if (contextMenuEmail) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [contextMenuEmail]);

    // Render loading state
    if (isLoading || !emails) {
        return (
            <div className="flex h-full items-center justify-center">
                <EigenLoader/>
            </div>
        );
    }

    return (
        <div className="w-full h-full flex flex-col overflow-hidden bg-white">
            {/* Search header */}
            <div className="flex items-center h-12 px-4 border-b">
                <div className="relative w-full">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"/>
                    <Input
                        placeholder="Search emails..."
                        value={globalFilter}
                        onChange={(e) => setGlobalFilter(e.target.value)}
                        className="pl-8 w-full h-9"
                    />
                </div>
            </div>

            {/* Email list as single column with blocks */}
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
                                        // Format as time if today
                                        formattedDate = date.toLocaleTimeString([], {
                                            hour: '2-digit',
                                            minute: '2-digit'
                                        });
                                    } else {
                                        // Format as date otherwise
                                        formattedDate = date.toLocaleDateString([], {month: 'short', day: 'numeric'});
                                    }
                                }

                                return (
                                    <div
                                        key={email.id}
                                        className={cn(
                                            "flex items-start py-2 px-3 eigen-list-item",
                                            // Selected: highlight background (matching sidebar active button)
                                            (activeRowId === email.id || selectedIndex === index) && "eigen-list-item-active",
                                            // Unread emails get slightly darker background if not selected
                                            !email.isRead && activeRowId !== email.id && selectedIndex !== index && "eigen-list-item-unread"
                                        )}
                                        onClick={() => onRowClick(email.id)}
                                        onContextMenu={(e) => handleContextMenu(e, email)}
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

            {/* Custom context menu using shadcn dropdown-menu */}
            <DropdownMenu
                open={!!contextMenuEmail}
                onOpenChange={(open) => !open && setContextMenuEmail(null)}
            >
                <DropdownMenuTrigger className="hidden">
                    {/* Hidden trigger */}
                </DropdownMenuTrigger>

                <EmailContextMenu
                    style={{
                        position: 'absolute',
                        top: `${menuPosition.y}px`,
                        left: `${menuPosition.x}px`,
                    }}
                    messageId={contextMenuEmail?.id}
                    mailboxes={mailboxes}
                    currentMailboxId={currentFolderId}
                    onReply={onReply}
                    onReplyAll={onReplyAll}
                    onForward={onForward}
                    onArchive={onArchive}
                    onReportSpam={onReportSpam}
                    onDelete={onDelete}
                    onMoveToFolder={onMoveToFolder}
                    onClose={() => setContextMenuEmail(null)}
                />
            </DropdownMenu>
        </div>
    );
}
