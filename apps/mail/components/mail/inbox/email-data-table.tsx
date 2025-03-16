import {
    ColumnDef,
    ColumnFiltersState,
    FilterFn,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    SortingState,
    useReactTable,
} from "@tanstack/react-table";
import {rankItem} from "@tanstack/match-sorter-utils";
import {Search} from "lucide-react";
import {useNavigate} from "@tanstack/react-router";
import {useState} from "react";
import { Email } from "@workspace/lib/types/mail";
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from "@workspace/ui/components/table";
import {cn} from "@workspace/ui/lib/utils";
import {Input} from "@workspace/ui/components/input";
import {Button} from "@workspace/ui/components/button";

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
    onRowClick?: (row: any) => void
}

export function EmailDataTable({
                                  columns,
                                  data,
                                  onRowClick
                              }: DataTableProps<Email>) {

    const [sorting, setSorting] = useState<SortingState>([])
    const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
    const [globalFilter, setGlobalFilter] = useState("")
    
    const navigate = useNavigate();

    const handleRowClick = async (row: any) => {
        if (onRowClick) {
            onRowClick(row);
        } else {
            await navigate({to: '/inbox/' + (row as Email).id});
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
        getPaginationRowModel: getPaginationRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        globalFilterFn: fuzzyFilter,
        state: {
            sorting,
            columnFilters,
            globalFilter,
        },
    })

    return (
        <div className="w-full h-full flex flex-col overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b">
            <div className="relative w-full max-w-sm">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                    placeholder="Search emails..."
                    value={globalFilter}
                    onChange={(e) => setGlobalFilter(e.target.value)}
                    className="pl-8 w-full"
                    />
                </div>
            </div>
            <div>
                <Table className="w-full table-fixed">
                    <TableHeader>
                        {table.getHeaderGroups().map((headerGroup) => (
                            <TableRow key={headerGroup.id}>
                                {headerGroup.headers.map((header) => {
                                    return (
                                        <TableHead 
                                            key={header.id} 
                                            className={cn(
                                                header.id === 'select' ? 'w-[44px] pl-6' : '',
                                                header.id === 'starred' ? 'w-[32px]' : '',
                                                header.id === 'from' ? 'w-[180px]' : '',
                                                header.id === 'date' ? 'w-[100px] pr-6' : '',
                                                header.id === 'labels' ? 'w-[120px]' : '',
                                                header.id === 'subject' ? 'w-auto' : ''
                                            )}
                                        >
                                            {header.isPlaceholder
                                                ? null
                                                : flexRender(
                                                    header.column.columnDef.header,
                                                    header.getContext()
                                                )}
                                        </TableHead>
                                    )
                                })}
                            </TableRow>
                        ))}
                    </TableHeader>
                    <TableBody>
                        {table.getRowModel().rows?.length ? (
                            table.getRowModel().rows.map((row) => (
                                <TableRow
                                    key={row.id}
                                    data-state={row.getIsSelected() && "selected"}
                                    className={cn(
                                        "cursor-pointer",
                                        !(row.original as Email).read && "bg-blue-50 font-medium"
                                    )}
                                    onClick={() => handleRowClick(row.original)}
                                >
                                    {row.getVisibleCells().map((cell) => (
                                        <TableCell key={cell.id} className={cn(
                                            cell.column.id === 'select' ? 'pl-6' : '',
                                            cell.column.id === 'starred' ? 'w-[30px]' : '',
                                            cell.column.id === 'date' ? 'pr-6' : '',
                                            cell.column.id === 'subject' ? 'truncate max-w-0' : ''
                                        )}>
                                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                        </TableCell>
                                    ))}
                                </TableRow>
                            ))
                        ) : (
                            <TableRow>
                                <TableCell colSpan={columns.length} className="h-24 text-center">
                                    No emails found.
                                </TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
            </div>
            <div className="flex items-center justify-between px-6 py-3 border-t">
                <div className="text-sm text-muted-foreground">
                    {table.getFilteredSelectedRowModel().rows.length} of{" "}
                    {table.getFilteredRowModel().rows.length} email(s) selected.
                </div>
                <div className="flex items-center space-x-2">
                    <div className="text-sm text-muted-foreground">
                        Page {table.getState().pagination.pageIndex + 1} of{" "}
                        {table.getPageCount()}
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => table.previousPage()}
                        disabled={!table.getCanPreviousPage()}
                    >
                        Previous
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => table.nextPage()}
                        disabled={!table.getCanNextPage()}
                    >
                        Next
                    </Button>
                </div>
            </div>
        </div>
    )
}
