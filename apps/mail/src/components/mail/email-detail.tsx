import { MAILBOX_ARCHIVE, MAILBOX_JUNK, MAILBOX_SENT } from '@workspace/lib/constants/mailboxes';
import { type Attachment, type Email, isCalendarPart, type MaildirMailbox } from '@workspace/lib/types/mail';
import { KebabTrigger, Toolbar, TooltipButton } from '@workspace/ui';
import { DropdownMenu, DropdownMenuContent } from '@workspace/ui/components/dropdown-menu';
import { MessageView } from '@workspace/ui/components/mail';
import { Separator } from '@workspace/ui/components/separator';
import { printDocument } from '@workspace/ui/lib/printElement';
import { AlertTriangle, Archive, Forward, Reply, ReplyAll, Trash2 } from 'lucide-react';
import { useEffect, useEffectEvent, useRef } from 'react';
import { CalendarInviteWidget } from './calendar-invite-widget';
import { EmailContextMenu } from './email-context-menu';
import { ReadAttachments } from './read-attachments';

type EmailDetailToolbarProps = {
    email: Email;
    onReply: (emailId: string) => void;
    onReplyAll: (emailId: string) => void;
    onForward: (emailId: string) => void;
    onArchive: (emailId: string) => void;
    onReportSpam: (emailId: string) => void;
    onDelete: (emailId: string) => void;
    onMoveToFolder: (emailId: string, folderId: string) => void;
    mailboxes?: MaildirMailbox[];
};

export function EmailDetailToolbar({
    email,
    onReply,
    onReplyAll,
    onForward,
    onArchive,
    onReportSpam,
    onDelete,
    onMoveToFolder,
    mailboxes = [],
}: EmailDetailToolbarProps) {
    return (
        <Toolbar>
            <div className="flex items-center gap-1">
                {email.mailbox !== MAILBOX_ARCHIVE && (
                    <TooltipButton icon={Archive} tooltipText="Archive" onClick={() => onArchive(email.id)} />
                )}
                {email.mailbox !== MAILBOX_JUNK && (
                    <TooltipButton
                        icon={AlertTriangle}
                        tooltipText="Report Spam"
                        onClick={() => onReportSpam(email.id)}
                    />
                )}
                <TooltipButton icon={Trash2} tooltipText="Delete" onClick={() => onDelete(email.id)} />
            </div>
            <div className="flex items-center gap-1">
                <TooltipButton icon={Reply} tooltipText="Reply" onClick={() => onReply(email.id)} />
                <TooltipButton icon={ReplyAll} tooltipText="Reply All" onClick={() => onReplyAll(email.id)} />
                <TooltipButton icon={Forward} tooltipText="Forward" onClick={() => onForward(email.id)} />
                <Separator orientation="vertical" className="h-6 mx-1" />
                <DropdownMenu>
                    <KebabTrigger />
                    <DropdownMenuContent className="w-56">
                        <EmailContextMenu
                            messageIds={[email.id]}
                            isSingleSelect={true}
                            mailboxes={mailboxes}
                            currentMailboxId={email.mailbox}
                            onReply={onReply}
                            onReplyAll={onReplyAll}
                            onForward={onForward}
                            onArchive={(ids) =>
                                ids.forEach((id) => {
                                    onArchive(id);
                                })
                            }
                            onReportSpam={(ids) =>
                                ids.forEach((id) => {
                                    onReportSpam(id);
                                })
                            }
                            onDelete={(ids) =>
                                ids.forEach((id) => {
                                    onDelete(id);
                                })
                            }
                            onMoveToFolder={(ids, folderId) =>
                                ids.forEach((id) => {
                                    onMoveToFolder(id, folderId);
                                })
                            }
                            onClose={() => {}}
                            onPrint={() => printDocument()}
                        />
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </Toolbar>
    );
}

type EmailDetailProps = {
    email: Email | null;
    toggleMailRead: (mail: Email, isRead: boolean) => void;
    highlightTerm?: string;
};

export function EmailDetail({ email, toggleMailRead, highlightTerm }: EmailDetailProps) {
    const hasMarkedAsRead = useRef<string | null>(null);

    // Mark on email change only; read the latest (unstable) toggleMailRead via an Effect Event.
    const markRead = useEffectEvent((mail: Email) => {
        toggleMailRead(mail, true);
    });

    useEffect(() => {
        if (email && !email.isRead && hasMarkedAsRead.current !== email.id) {
            hasMarkedAsRead.current = email.id;
            markRead(email);
        }
    }, [email]);

    if (!email) {
        return (
            <div className="flex h-full items-center justify-center text-muted-foreground">
                Email data not available
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-background">
            {/* y-scroll (not auto): the body's scale-to-fit reacts to pane width, so a scrollbar
                that comes and goes with the scaled height would oscillate on classic scrollbars. */}
            <div className="app-gutter flex-1 overflow-y-scroll" data-document="email-detail">
                <MessageView
                    subject={email.subject}
                    from={email.from}
                    replyTo={email.replyTo}
                    to={email.to}
                    cc={email.cc}
                    bcc={email.bcc}
                    date={email.date}
                    html={email.html}
                    textAsHtml={email.textAsHtml}
                    text={email.text}
                    isSent={email.mailbox === MAILBOX_SENT}
                    highlightTerm={highlightTerm}
                    attachments={<ReadAttachments emailId={email.id} attachments={email.attachments} />}
                    footer={email.attachments?.map(
                        (attachment: Attachment) =>
                            isCalendarPart(attachment) && (
                                <CalendarInviteWidget key={attachment.index} invite={attachment.calendarInvite} />
                            ),
                    )}
                />
            </div>
        </div>
    );
}
