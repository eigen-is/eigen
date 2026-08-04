import { getMailMessageDownloadUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import type { MaildirMailbox } from '@workspace/lib/types/mail';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { ucfirst } from '@workspace/ui/lib/utils';
import { AlertTriangle, Archive, Download, Forward, Printer, Reply, ReplyAll, Trash2 } from 'lucide-react';

type EmailContextMenuProps = {
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
};

export function EmailContextMenu({
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
    onPrint,
}: EmailContextMenuProps) {
    const { user } = useAuth();
    const firstId = messageIds[0] || '';

    return (
        <>
            {isSingleSelect && onPrint && (
                <>
                    <DropdownMenuItem
                        onClick={() => {
                            onPrint(firstId);
                            onClose();
                        }}
                    >
                        <Printer className="mr-2" />
                        Print
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                </>
            )}

            {isSingleSelect && (
                <>
                    <DropdownMenuItem
                        onClick={() => {
                            onReply?.(firstId);
                            onClose();
                        }}
                    >
                        <Reply className="mr-2" />
                        Reply
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onClick={() => {
                            onReplyAll?.(firstId);
                            onClose();
                        }}
                    >
                        <ReplyAll className="mr-2" />
                        Reply All
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onClick={() => {
                            onForward?.(firstId);
                            onClose();
                        }}
                    >
                        <Forward className="mr-2" />
                        Forward
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                </>
            )}

            {currentMailboxId !== 'Archive' && (
                <DropdownMenuItem
                    onClick={() => {
                        onArchive?.(messageIds);
                        onClose();
                    }}
                >
                    <Archive className="mr-2" />
                    {isSingleSelect ? 'Archive' : `Archive ${messageIds.length} emails`}
                </DropdownMenuItem>
            )}
            {currentMailboxId !== 'Junk' && (
                <DropdownMenuItem
                    onClick={() => {
                        onReportSpam?.(messageIds);
                        onClose();
                    }}
                >
                    <AlertTriangle className="mr-2" />
                    Report Spam
                </DropdownMenuItem>
            )}
            <DropdownMenuItem
                onClick={() => {
                    onDelete?.(messageIds);
                    onClose();
                }}
            >
                <Trash2 className="mr-2" />
                {isSingleSelect ? 'Delete' : `Delete ${messageIds.length} emails`}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {isSingleSelect && (
                <>
                    <DropdownMenuItem
                        onClick={() => {
                            if (!user) return;
                            const url = getMailMessageDownloadUrl(user.id, firstId);
                            window.open(url, '_blank');
                            onClose();
                        }}
                    >
                        <Download className="mr-2" />
                        Download
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                </>
            )}

            <DropdownMenuSub>
                <DropdownMenuSubTrigger>Move to folder</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-48">
                    {mailboxes
                        .filter((mailbox) => mailbox.path !== currentMailboxId)
                        .map((mailbox) => (
                            <DropdownMenuItem
                                key={mailbox.path}
                                onClick={() => {
                                    onMoveToFolder?.(messageIds, mailbox.path);
                                    onClose();
                                }}
                            >
                                {ucfirst(mailbox.name)}
                            </DropdownMenuItem>
                        ))}
                </DropdownMenuSubContent>
            </DropdownMenuSub>
        </>
    );
}
