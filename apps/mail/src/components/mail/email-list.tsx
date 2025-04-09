import {FilterFn, getCoreRowModel, getFilteredRowModel, getSortedRowModel, SortingState, useReactTable} from "@tanstack/react-table";
import {rankItem} from "@tanstack/match-sorter-utils";
import {Paperclip, Search} from "lucide-react";
import {useMemo, useState, useRef, useEffect, KeyboardEvent} from "react";
import {cn} from "@workspace/ui/lib/utils";
import {Input} from "@workspace/ui/components/input";
import {EigenLoader} from "@workspace/ui/components/layout/eigen-loader";
import {EmailSummary} from "@apps/api-server/types/mail";

// Define a fuzzy filter function
const fuzzyFilter: FilterFn<any> = (row, columnId, value, addMeta) => {
    // Rank the item
    const itemRank = rankItem(row.getValue(columnId), value)

    // Store the ranking info
    addMeta({
        itemRank,
    })

    // Return if the item should be filtered in/out
    return itemRank.passed
}

interface EmailDataTableProps {
    emails: EmailSummary[];
    onRowClick: (emailId: string) => void;
    activeRowId?: string;
    isLoading?: boolean;
    error?: any;
}

export function EmailList({
                              emails,
                              onRowClick,
                              activeRowId,
                              isLoading,
                              error,
                          }: EmailDataTableProps) {

    // Ref voor de lijst container
    const listContainerRef = useRef<HTMLDivElement>(null);
    
    // State om bij te houden of de lijst focus heeft
    const [hasFocus, setHasFocus] = useState(false);
    
    // State voor het bijhouden van de huidige geselecteerde index
    const [selectedIndex, setSelectedIndex] = useState<number>(-1);

    // Define columns with useMemo to prevent recreation on each render
    const columns = useMemo(() => [
        {
            header: 'Date',
            accessor: 'date',
            id: 'date',
        },
        {
            header: 'From',
            accessor: 'from',
            id: 'from',
        },
        {
            header: 'Subject',
            accessor: 'subject',
            id: 'subject',
        },
        {
            header: 'Content',
            accessor: 'textShort',
            id: 'textShort',
        }
    ], []);

    const [sorting, setSorting] = useState<SortingState>([
        {
            id: 'date',
            desc: true
        }
    ]);
    const [globalFilter, setGlobalFilter] = useState("");

    const handleRowClick = (row: EmailSummary) => {
        onRowClick(row.id);
        row.isRead = true;
    };

    // Using useMemo to prevent infinite rendering when emails array remains the same
    const emailData = useMemo(() => {
        // Create a stable reference to avoid recreating the array on each render
        return [...emails].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()) || [];
    }, [emails]);

    // Creëer de tabel
    const table = useReactTable({
        data: emailData,
        columns: columns,
        filterFns: {
            fuzzy: fuzzyFilter,
        },
        onSortingChange: setSorting,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        globalFilterFn: fuzzyFilter,
        onGlobalFilterChange: setGlobalFilter,
        getFilteredRowModel: getFilteredRowModel(),
        sortDescFirst: true,
        state: {
            sorting,
            globalFilter,
        },
    });

    // Gefilterde e-mails voor gebruik met toetsenbord navigatie
    const filteredEmails = useMemo(() => {
        return table.getFilteredRowModel().rows.map(row => row.original as EmailSummary);
    }, [emailData, globalFilter, table.getFilteredRowModel]);

    // Effect om de lijst automatisch focus te geven bij het laden
    useEffect(() => {
        // Korte timeout om ervoor te zorgen dat de lijst eerst gerenderd is
        const timer = setTimeout(() => {
            if (listContainerRef.current) {
                listContainerRef.current.focus();
            }
        }, 100);
        
        return () => clearTimeout(timer);
    }, []);

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
        if (!hasFocus || filteredEmails.length === 0) return;
        
        switch(e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setSelectedIndex(prev => {
                    const newIndex = Math.min(prev + 1, filteredEmails.length - 1);
                    if (newIndex >= 0) {
                        // Item selecteren
                        handleRowClick(filteredEmails[newIndex]);
                        // Auto-scroll indien nodig
                        scrollToEmail(newIndex);
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
                        handleRowClick(filteredEmails[newIndex]);
                        // Auto-scroll indien nodig
                        scrollToEmail(newIndex);
                    }
                    return newIndex;
                });
                break;
                
            case 'Enter':
                e.preventDefault();
                if (selectedIndex >= 0 && selectedIndex < filteredEmails.length) {
                    handleRowClick(filteredEmails[selectedIndex]);
                }
                break;
                
            case 'Home':
                e.preventDefault();
                if (filteredEmails.length > 0) {
                    setSelectedIndex(0);
                    handleRowClick(filteredEmails[0]);
                    scrollToEmail(0);
                }
                break;
                
            case 'End':
                e.preventDefault();
                if (filteredEmails.length > 0) {
                    const lastIndex = filteredEmails.length - 1;
                    setSelectedIndex(lastIndex);
                    handleRowClick(filteredEmails[lastIndex]);
                    scrollToEmail(lastIndex);
                }
                break;
        }
    };

    // Helper functie om naar een specifieke email te scrollen
    const scrollToEmail = (index: number) => {
        if (listContainerRef.current) {
            const emailElements = listContainerRef.current.querySelectorAll('.eigen-list-item');
            if (emailElements[index]) {
                emailElements[index].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
    };

    // Render loading state
    if (isLoading || !emails) {
        return (
            <div className="flex h-full items-center justify-center">
                <EigenLoader/>
            </div>
        );
    }

    // Render error state
    if (error) {
        return (
            <div className="flex flex-col h-full items-center justify-center p-4">
                <div className="text-red-500 mb-4">
                    Error loading emails. Please try again.
                </div>
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
                ref={listContainerRef}
                tabIndex={0}
                onFocus={() => setHasFocus(true)}
                onBlur={() => setHasFocus(false)}
                onKeyDown={handleKeyDown}
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
                                        onClick={() => handleRowClick(email)}
                                    >
                                        {/* Content layout */}
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
        </div>
    );
}
