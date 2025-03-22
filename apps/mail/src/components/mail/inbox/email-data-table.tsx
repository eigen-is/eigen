import {
    ColumnDef,
    ColumnFiltersState,
    FilterFn,
    getCoreRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    SortingState,
    useReactTable,
} from "@tanstack/react-table";
import { rankItem } from "@tanstack/match-sorter-utils";
import { Paperclip, Search } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Email } from "@workspace/lib/types/mail";
import { cn } from "@workspace/ui/lib/utils";
import { Input } from "@workspace/ui/components/input";

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

interface DataTableProps<TData> {
    columns: ColumnDef<TData, unknown>[]
    data: TData[]
    onRowClick?: (emailId: string) => void
    activeRowId?: string
}

export function EmailDataTable({
    columns,
    data,
    onRowClick,
    activeRowId
}: DataTableProps<Email>) {

    const [sorting, setSorting] = useState<SortingState>([])
    const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
    const [globalFilter, setGlobalFilter] = useState("")
    
    const navigate = useNavigate();

    const handleRowClick = (row: Email) => {
        if (onRowClick) {
            onRowClick(row.id);
        } else {
            navigate({to: '/inbox/' + row.id});
        }
    };

    const table = useReactTable({
        data,
        columns,
        filterFns: {
            fuzzy: fuzzyFilter,
        },
        onSortingChange: setSorting,
        onColumnFiltersChange: setColumnFilters,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        globalFilterFn: fuzzyFilter,
        state: {
            sorting,
            columnFilters,
            globalFilter,
        },
    });

    return (
        <div className="w-full h-full flex flex-col overflow-hidden bg-white">
            {/* Search header */}
            <div className="flex items-center h-12 px-4 border-b">
                <div className="relative w-full">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Search emails..."
                        value={globalFilter}
                        onChange={(e) => setGlobalFilter(e.target.value)}
                        className="pl-8 w-full h-9"
                    />
                </div>
            </div>
            
            {/* Email list as single column with blocks */}
            <div className="flex-1 overflow-y-auto">
                <div className="w-full">
                    {table.getFilteredRowModel().rows.length > 0 ? (
                        <div className="divide-y divide-gray-100">
                            {table.getFilteredRowModel().rows.map((row) => {
                                const email = row.original as Email;
                                return (
                                    <div
                                        key={row.id}
                                        className={cn(
                                            "flex items-start py-2 px-3 cursor-pointer bg-white",
                                            // Not selected: hover color (matching sidebar buttons)
                                            activeRowId !== email.id && "hover:bg-accent",
                                            // Selected: highlight background (matching sidebar active button)
                                            activeRowId === email.id && "bg-accent text-accent-foreground",
                                            // Unread emails get slightly darker background if not selected
                                            !email.read && activeRowId !== email.id && "bg-blue-50/20"
                                        )}
                                        onClick={() => handleRowClick(email)}
                                    >
                                        {/* Dot for important emails */}
                                        {email.important && (
                                            <div className="mt-1 mr-1.5 text-yellow-500 text-xs">•</div>
                                        )}
                                        
                                        {/* Content layout */}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex justify-between items-baseline">
                                                <div className={cn(
                                                    "text-sm text-gray-900",
                                                    !email.read && "font-semibold"
                                                )}>
                                                    {email.from.name}
                                                </div>
                                                <div className="text-xs text-gray-500 whitespace-nowrap ml-2">
                                                    {email.date}
                                                </div>
                                            </div>
                                            <div className={cn(
                                                "text-sm truncate mt-0.5 text-gray-700",
                                                !email.read && "font-medium"
                                            )}>
                                                {email.subject}
                                            </div>
                                            <div className="text-xs truncate text-gray-500 mt-0.5 flex items-center">
                                                <span className="truncate">{email.preview}</span>
                                                {email.hasAttachment && (
                                                    <Paperclip className="h-3 w-3 ml-1 shrink-0 text-gray-400" />
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
