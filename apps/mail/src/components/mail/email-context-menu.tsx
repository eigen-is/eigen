// The menu of things to do with one message or a selection of them, such as reply, archive, move or delete. The
// message list shows it on right-click, and the open message shows it from its toolbar.

import { getMailMessageDownloadUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import {
    MAILBOX_ARCHIVE,
    MAILBOX_JUNK,
    mailboxDisplayName,
    specialMailboxFromFlags,
} from '@workspace/lib/constants/mailboxes';
import type { MaildirMailbox } from '@workspace/lib/types/mail';
import { MenuSections } from '@workspace/ui/components/context-menu';
import {
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { AlertTriangle, Archive, Download, FolderInput, Forward, Printer, Reply, ReplyAll, Trash2 } from 'lucide-react';

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

    const run = (fn: () => void) => () => {
        fn();
        onClose();
    };

    return (
        <MenuSections
            open={
                isSingleSelect && (
                    <>
                        <DropdownMenuItem onClick={run(() => onReply?.(firstId))}>
                            <Reply />
                            Reply
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={run(() => onReplyAll?.(firstId))}>
                            <ReplyAll />
                            Reply all
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={run(() => onForward?.(firstId))}>
                            <Forward />
                            Forward
                        </DropdownMenuItem>
                    </>
                )
            }
            organize={
                <>
                    {currentMailboxId !== MAILBOX_ARCHIVE && (
                        <DropdownMenuItem onClick={run(() => onArchive?.(messageIds))}>
                            <Archive />
                            {isSingleSelect ? 'Archive' : `Archive ${messageIds.length} emails`}
                        </DropdownMenuItem>
                    )}
                    {currentMailboxId !== MAILBOX_JUNK && (
                        <DropdownMenuItem onClick={run(() => onReportSpam?.(messageIds))}>
                            <AlertTriangle />
                            Report spam
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                            <FolderInput />
                            Move to folder
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-48">
                            {mailboxes
                                .filter((mailbox) => mailbox.path !== currentMailboxId)
                                .map((mailbox) => {
                                    const special = specialMailboxFromFlags(mailbox.flags);
                                    return (
                                        <DropdownMenuItem
                                            key={mailbox.path}
                                            onClick={run(() => onMoveToFolder?.(messageIds, mailbox.path))}
                                        >
                                            {special ? special.label : mailboxDisplayName(mailbox.path)}
                                        </DropdownMenuItem>
                                    );
                                })}
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                </>
            }
            output={
                isSingleSelect && (
                    <>
                        <DropdownMenuItem
                            onClick={run(() => {
                                if (user) window.open(getMailMessageDownloadUrl(user.id, firstId), '_blank');
                            })}
                        >
                            <Download />
                            Download
                        </DropdownMenuItem>
                        {onPrint && (
                            <DropdownMenuItem onClick={run(() => onPrint(firstId))}>
                                <Printer />
                                Print
                            </DropdownMenuItem>
                        )}
                    </>
                )
            }
            destructive={
                <DropdownMenuItem variant="destructive" onClick={run(() => onDelete?.(messageIds))}>
                    <Trash2 />
                    {isSingleSelect ? 'Delete' : `Delete ${messageIds.length} emails`}
                </DropdownMenuItem>
            }
        />
    );
}
