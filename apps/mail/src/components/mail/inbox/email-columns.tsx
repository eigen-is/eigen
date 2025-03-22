import { ColumnDef, FilterFnOption } from "@tanstack/react-table"
import { Paperclip } from "lucide-react"
import { Email } from "@workspace/lib/types/mail";
import { cn } from "@workspace/ui/lib/utils";

// Simplified columns based on Apple Mail inspiration
export const emailColumns: ColumnDef<Email>[] = [
    {
        accessorKey: "from",
        header: "From",
        cell: ({ row }) => {
            const email = row.original
            return (
                <div className="flex items-center">
                    <span className={cn("font-medium truncate", !email.read && "font-semibold")}>
                        {email.important && <span className="text-yellow-500 mr-1">•</span>}
                        {email.from.name}
                    </span>
                </div>
            )
        },
        filterFn: "fuzzy" as FilterFnOption<Email>,
    },
    {
        accessorKey: "content",
        header: "Content",
        cell: ({ row }) => {
            const email = row.original
            return (
                <div className="flex flex-col overflow-hidden text-sm">
                    <div className={cn("truncate", !email.read && "font-semibold")}>
                        {email.subject}
                    </div>
                    <div className="truncate text-muted-foreground">
                        {email.preview}
                        {email.hasAttachment && (
                            <Paperclip size={14} className="ml-1 inline-block text-muted-foreground" />
                        )}
                    </div>
                </div>
            )
        },
        filterFn: "fuzzy" as FilterFnOption<Email>,
    },
    {
        accessorKey: "date",
        header: "Date",
        cell: ({ row }) => {
            return (
                <div className="text-right text-muted-foreground whitespace-nowrap text-sm">
                    {row.original.date}
                </div>
            )
        },
    },
]
