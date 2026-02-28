import {AlertTriangle, Archive, Download, Forward, Printer, Reply, ReplyAll, Trash2} from "lucide-react";
import {
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger
} from "@workspace/ui/components/dropdown-menu";
import {MaildirMailbox} from "@workspace/lib/types/mail";
import {ucfirst} from "@workspace/ui/lib/utils";
import {getMailMessageDownloadUrl} from "@workspace/lib/api";
import {CSSProperties} from "react";

interface EmailContextMenuProps {
    style: CSSProperties;
    messageIds: string[];
    isSingleSelect: boolean;
    mailboxes: MaildirMailbox[];
    currentMailboxId: string;
    onReply?: (emailId: string) => void;
    onReplyAll?: (emailId: string) => void;
    onForward?: (emailId: string) => void;
    onArchive?: (emailIds: string[]) => void;
    onReportSpam?: (emailIds: string[]) => void;
    onDelete?: (emailIds: string[]) => void;
    onMoveToFolder?: (emailIds: string[], folderId: string) => void;
    onClose: () => void;
    onPrint?: (emailId: string) => void;
}

export function EmailContextMenu({
                                     style,
                                     messageIds,
                                     isSingleSelect,
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
    const firstId = messageIds[0] || '';

    return (
        <DropdownMenuContent
            style={style}
            className="w-56"
        >
            {isSingleSelect && onPrint && (
                <>
                    <DropdownMenuItem onClick={() => {
                        onPrint(firstId);
                        onClose();
                    }}>
                        <Printer className="mr-2"/>
                        Print
                    </DropdownMenuItem>
                    <DropdownMenuSeparator/>
                </>
            )}

            {isSingleSelect && (
                <>
                    <DropdownMenuItem onClick={() => {
                        onReply?.(firstId);
                        onClose();
                    }}>
                        <Reply className="mr-2"/>
                        Reply
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => {
                        onReplyAll?.(firstId);
                        onClose();
                    }}>
                        <ReplyAll className="mr-2"/>
                        Reply All
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => {
                        onForward?.(firstId);
                        onClose();
                    }}>
                        <Forward className="mr-2"/>
                        Forward
                    </DropdownMenuItem>
                    <DropdownMenuSeparator/>
                </>
            )}

            <DropdownMenuItem onClick={() => {
                onArchive?.(messageIds);
                onClose();
            }}>
                <Archive className="mr-2"/>
                {isSingleSelect ? 'Archive' : `Archive ${messageIds.length} emails`}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => {
                onReportSpam?.(messageIds);
                onClose();
            }}>
                <AlertTriangle className="mr-2"/>
                Report Spam
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => {
                onDelete?.(messageIds);
                onClose();
            }}>
                <Trash2 className="mr-2"/>
                {isSingleSelect ? 'Delete' : `Delete ${messageIds.length} emails`}
            </DropdownMenuItem>

            <DropdownMenuSeparator/>

            {isSingleSelect && (
                <>
                    <DropdownMenuItem onClick={() => {
                        const url = getMailMessageDownloadUrl(firstId);
                        window.open(url, "_blank");
                        onClose();
                    }}>
                        <Download className="mr-2"/>
                        Download
                    </DropdownMenuItem>
                    <DropdownMenuSeparator/>
                </>
            )}

            <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                    Move to folder
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-48">
                    {mailboxes
                        .filter(mailbox => mailbox.name !== currentMailboxId)
                        .map(mailbox => (
                            <DropdownMenuItem
                                key={ucfirst(mailbox.name)}
                                onClick={() => {
                                    onMoveToFolder?.(messageIds, mailbox.name === 'INBOX' ? '' : mailbox.name);
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
