import {ColumnDef, FilterFnOption} from "@tanstack/react-table"
import {Paperclip} from "lucide-react"
import {cn} from "@workspace/ui/lib/utils";
import {Email} from "@/types/email";

// Simplified columns based on Apple Mail inspiration
export const emailColumns: ColumnDef<Email>[] = [
    {
        accessorKey: "from",
        header: "From",
        cell: ({ row }) => {
            const email = row.original;
            // Handle different from formats from the API
            let fromName = 'Unknown';
            
            if (typeof email.from === 'object') {
                if (email.from.value && Array.isArray(email.from.value) && email.from.value.length > 0) {
                    // Handle the structure from the screenshot with value array
                    fromName = email.from.value[0].name || email.from.value[0].address || 'Unknown';
                } else {
                    // Handle regular object format
                    fromName = email.from.name || email.from.email || 'Unknown';
                }
            } else if (typeof email.from === 'string') {
                fromName = email.from || 'Unknown';
            }
            
            return (
                <div className="flex items-center">
                    <span className={cn("font-medium truncate", !(email.read || email.isRead) && "font-semibold")}>
                        {email.important && <span className="text-yellow-500 mr-1">•</span>}
                        {fromName}
                    </span>
                </div>
            )
        },
        filterFn: "fuzzy" as FilterFnOption<Email>,
    },
    {
        accessorKey: "subject",
        header: "Content",
        cell: ({ row }) => {
            const email = row.original;
            const preview = typeof email.preview === 'string' 
                ? email.preview 
                : typeof email.text === 'string' 
                    ? email.text.substring(0, 100) 
                    : '';
            
            return (
                <div className="flex flex-col overflow-hidden text-sm">
                    <div className={cn("truncate", !(email.read || email.isRead) && "font-semibold")}>
                        {email.subject ? String(email.subject) : '(No subject)'}
                    </div>
                    <div className="truncate text-muted-foreground">
                        {preview}
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
            const email = row.original;
            // Format date for display
            let formattedDate = '';
            try {
                if (email.date) {
                    const date = new Date(email.date);
                    const now = new Date();
                    const isToday = date.toDateString() === now.toDateString();
                    
                    if (isToday) {
                        // Format as time if today
                        formattedDate = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    } else {
                        // Format as date otherwise
                        formattedDate = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
                    }
                }
            } catch (error) {
                console.error('Error formatting date:', error);
                formattedDate = email.date || '';
            }
            
            return (
                <div className="text-xs text-muted-foreground whitespace-nowrap">
                    {formattedDate}
                </div>
            )
        },
    },
];
