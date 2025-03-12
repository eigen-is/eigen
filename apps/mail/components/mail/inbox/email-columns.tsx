import {ColumnDef, FilterFnOption} from "@tanstack/react-table"
import {ArrowUpDown, Paperclip, Star} from "lucide-react"
// @ts-ignore
import {Email} from "@workspace/ui/src/types";
import {Checkbox} from "@workspace/ui/components/ui/checkbox";
import {Button} from "@workspace/ui/components/ui/button";
import {cn} from "@workspace/ui/lib/utils";
import {Badge} from "@workspace/ui/components/ui/badge";


export const emailColumns: ColumnDef<Email>[] = [
    {
        id: "select",
        header: ({table}) => (
            <Checkbox
                checked={
                    table.getIsAllPageRowsSelected() ||
                    (table.getIsSomePageRowsSelected() && "indeterminate")
                }
                onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
                aria-label="Select all"
                className="h-4 w-4"
            />
        ),
        cell: ({row}) => (
            <Checkbox
                checked={row.getIsSelected()}
                onCheckedChange={(value) => row.toggleSelected(!!value)}
                aria-label="Select row"
                className="h-4 w-4"
                onClick={(e) => e.stopPropagation()}
            />
        ),
        enableSorting: false,
        enableHiding: false,
    },
    {
        id: "starred",
        cell: ({row}) => {
            const email = row.original
            return (
                <button
                    className="text-gray-400 hover:text-yellow-400"
                    onClick={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        // Handle star toggle functionality here
                    }}
                >
                    <Star
                        size={18}
                        fill={email.starred ? "gold" : "none"}
                        color={email.starred ? "gold" : "currentColor"}
                    />
                </button>
            )
        },
        enableSorting: false,
        enableHiding: false,
    },
    {
        accessorKey: "from",
        header: ({column}) => {
            return (
                <Button
                    variant="ghost"
                    onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                    className="p-0 hover:bg-transparent"
                >
                    From
                    <ArrowUpDown className="ml-2 h-4 w-4"/>
                </Button>
            )
        },
        cell: ({row}) => {
            const email = row.original
            return (
                <div className="flex items-center">
          <span className={cn("truncate max-w-[200px]", !email.read && "font-semibold")}>
            {email.important && <span className="text-yellow-500 mr-1">!</span>}
              {email.from.name}
          </span>
                </div>
            )
        },
        filterFn: "fuzzy" as FilterFnOption<Email>,
    },
    {
        accessorKey: "subject",
        header: ({column}) => {
            return (
                <Button
                    variant="ghost"
                    onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                    className="p-0 hover:bg-transparent"
                >
                    Subject
                    <ArrowUpDown className="ml-2 h-4 w-4"/>
                </Button>
            )
        },
        cell: ({row}) => {
            const email = row.original
            return (
                <div className="flex items-center justify-between gap-2 min-w-0">
          <span className="truncate">
            {email.subject} - <span className="text-muted-foreground">{email.preview}</span>
          </span>
                    {email.hasAttachment && <Paperclip size={14} className="text-muted-foreground shrink-0"/>}
                </div>
            )
        },
        filterFn: "fuzzy" as FilterFnOption<Email>,
    },
    {
        accessorKey: "labels",
        header: "Labels",
        cell: ({row}) => {
            const labels = row.getValue("labels") as string[]
            if (!labels?.length) return null
            return (
                <div className="flex gap-1">
                    {labels.map((label) => (
                        <Badge key={label} variant="outline">
                            {label}
                        </Badge>
                    ))}
                </div>
            )
        },
        filterFn: (row, id, value) => {
            const labels = row.getValue(id) as string[]
            return labels?.some((label) => label.includes(value))
        },
    },
    {
        accessorKey: "date",
        header: ({column}) => {
            return (
                <Button
                    variant="ghost"
                    onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                    className="p-0 hover:bg-transparent"
                >
                    Date
                    <ArrowUpDown className="ml-2 h-4 w-4"/>
                </Button>
            )
        },
        cell: ({row}) => {
            return (
                <div className="text-right text-muted-foreground whitespace-nowrap">
                    {row.original.date}
                </div>
            )
        },
    },
]
