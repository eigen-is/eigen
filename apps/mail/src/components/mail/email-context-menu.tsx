import {
    Archive,
    Forward,
    Reply,
    ReplyAll,
    Trash2,
    AlertTriangle
} from "lucide-react";
import {
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger
} from "@workspace/ui/components/dropdown-menu";
import { MaildirMailbox } from "@apps/api-server/types/mail";
import { ucfirst } from "@workspace/ui/lib/utils";
import { CSSProperties } from "react";
import { Printer } from "lucide-react";

interface EmailContextMenuProps {
    style: CSSProperties;
    messageId?: string;
    mailboxes: MaildirMailbox[];
    currentMailboxId: string;
    onReply?: (emailId: string) => void;
    onReplyAll?: (emailId: string) => void;
    onForward?: (emailId: string) => void;
    onArchive?: (emailId: string) => void;
    onReportSpam?: (emailId: string) => void;
    onDelete?: (emailId: string) => void;
    onMoveToFolder?: (emailId: string, folderId: string) => void;
    onClose: () => void;
    onPrint?: (emailId: string) => void;
}

export function EmailContextMenu({
    style,
    messageId = '',
    mailboxes = [],
    currentMailboxId = '',
    onReply,
    onReplyAll,
    onForward,
    onArchive,
    onReportSpam,
    onDelete,
    onMoveToFolder,
    onClose,
    onPrint
}: EmailContextMenuProps) {
    return (
        <DropdownMenuContent
            style={style}
            className="w-56"
        >
            {onPrint && (
                <>
                <DropdownMenuItem 
                    onClick={() => {
                        onPrint?.(messageId);
                        onClose();
                    }}
                    className="flex items-center"
                >
                    <Printer className="h-4 w-4 mr-2" />
                    Print
                </DropdownMenuItem>
                <DropdownMenuSeparator /> 
                </>
            )}

            {/* Reply options */}
            <DropdownMenuItem 
                onClick={() => {
                    onReply?.(messageId);
                    onClose();
                }}
                className="flex items-center"
            >
                <Reply className="h-4 w-4 mr-2" />
                Reply
            </DropdownMenuItem>
            <DropdownMenuItem 
                onClick={() => {
                    onReplyAll?.(messageId);
                    onClose();
                }}
                className="flex items-center"
            >
                <ReplyAll className="h-4 w-4 mr-2" />
                Reply All
            </DropdownMenuItem>
            <DropdownMenuItem 
                onClick={() => {
                    onForward?.(messageId);
                    onClose();
                }}
                className="flex items-center"
            >
                <Forward className="h-4 w-4 mr-2" />
                Forward
            </DropdownMenuItem>
            
            <DropdownMenuSeparator />
            
            {/* Email actions */}
            <DropdownMenuItem 
                onClick={() => {
                    onArchive?.(messageId);
                    onClose();
                }}
                className="flex items-center"
            >
                <Archive className="h-4 w-4 mr-2" />
                Archive
            </DropdownMenuItem>
            <DropdownMenuItem 
                onClick={() => {
                    onReportSpam?.(messageId);
                    onClose();
                }}
                className="flex items-center"
            >
                <AlertTriangle className="h-4 w-4 mr-2" />
                Report Spam
            </DropdownMenuItem>
            <DropdownMenuItem 
                onClick={() => {
                    onDelete?.(messageId);
                    onClose();
                }}
                className="flex items-center"
            >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
            </DropdownMenuItem>
            
            <DropdownMenuSeparator />
            
            {/* Move to folder submenu */}
            <DropdownMenuSub>
                <DropdownMenuSubTrigger className="flex items-center">
                    Move to folder
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-48">
                    {mailboxes
                        .filter(mailbox => mailbox.name !== currentMailboxId)
                        .map(mailbox => (
                            <DropdownMenuItem
                                key={ucfirst(mailbox.name)}
                                onClick={() => {
                                    onMoveToFolder?.(messageId, mailbox.name === 'INBOX' ? '' : mailbox.name);
                                    onClose();
                                }}
                            >
                                {ucfirst(mailbox.name)}
                            </DropdownMenuItem>
                        ))}
                </DropdownMenuSubContent>
            </DropdownMenuSub>
        </DropdownMenuContent>
    );
}
