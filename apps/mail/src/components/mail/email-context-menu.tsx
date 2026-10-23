import { getMailMessageDownloadUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import {
    MAILBOX_ARCHIVE,
    MAILBOX_JUNK,
    mailboxDisplayName,
    specialMailboxFromFlags,
} from '@workspace/lib/constants/mailboxes';
import type { MaildirMailbox } from '@workspace/lib/types/mail';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
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
    currentMailboxId,
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
                        <Printer />
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
                        <Reply />
                        Reply
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onClick={() => {
                            onReplyAll?.(firstId);
                            onClose();
                        }}
                    >
                        <ReplyAll />
                        Reply All
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onClick={() => {
                            onForward?.(firstId);
                            onClose();
                        }}
                    >
                        <Forward />
                        Forward
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                </>
            )}

            {currentMailboxId !== MAILBOX_ARCHIVE && (
                <DropdownMenuItem
                    onClick={() => {
                        onArchive?.(messageIds);
                        onClose();
                    }}
                >
                    <Archive />
                    {isSingleSelect ? 'Archive' : `Archive ${messageIds.length} emails`}
                </DropdownMenuItem>
            )}
            {currentMailboxId !== MAILBOX_JUNK && (
                <DropdownMenuItem
                    onClick={() => {
                        onReportSpam?.(messageIds);
                        onClose();
                    }}
                >
                    <AlertTriangle />
                    Report Spam
                </DropdownMenuItem>
            )}
            <DropdownMenuItem
                onClick={() => {
                    onDelete?.(messageIds);
                    onClose();
                }}
            >
                <Trash2 />
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
                        <Download />
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
                        .map((mailbox) => {
                            const special = specialMailboxFromFlags(mailbox.flags);
                            return (
                                <DropdownMenuItem
                                    key={mailbox.path}
                                    onClick={() => {
                                        onMoveToFolder?.(messageIds, mailbox.path);
                                        onClose();
                                    }}
                                >
                                    {special ? special.label : mailboxDisplayName(mailbox.path)}
                                </DropdownMenuItem>
                            );
                        })}
                </DropdownMenuSubContent>
            </DropdownMenuSub>
        </>
    );
}
