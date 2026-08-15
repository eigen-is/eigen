import { getMailComposeUrl } from '@workspace/lib/api';
import { formatDateTime } from '@workspace/lib/date';
import { flattenAddresses } from '@workspace/lib/mail/addresses';
import type { AddressObject, Attachment, Email, MaildirMailbox } from '@workspace/lib/types/mail';
import { KebabTrigger, ShadowContent, Toolbar, TooltipButton } from '@workspace/ui';
import { DropdownMenu, DropdownMenuContent } from '@workspace/ui/components/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { Separator } from '@workspace/ui/components/separator';
import { UserAvatar } from '@workspace/ui/components/user';
import { printDocument } from '@workspace/ui/lib/printElement';
import { AlertTriangle, Archive, ChevronDown, Forward, Reply, ReplyAll, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useEffectEvent, useRef } from 'react';
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
                {email.mailbox !== 'Archive' && (
                    <TooltipButton icon={Archive} tooltipText="Archive" onClick={() => onArchive(email.id)} />
                )}
                {email.mailbox !== 'Junk' && (
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

export function MailLink({
    email,
    name,
    mailLink = true,
    compact = false,
}: {
    email?: string;
    name: string;
    mailLink?: boolean;
    compact?: boolean;
}) {
    let label =
        name && email ? (
            <>
                {name} &lt;{email}&gt;
            </>
        ) : (
            (email ?? undefined)
        );
    if (compact) {
        label = email ?? undefined;
    }
    return (
        email && (
            <span className="text-xs text-muted-foreground">
                {mailLink ? (
                    <a className="hover:underline" href={getMailComposeUrl(email)} title={email}>
                        {label}
                    </a>
                ) : (
                    label
                )}
            </span>
        )
    );
}

function formatContactObject(contact: AddressObject, compact: boolean = false) {
    return contact.value.map((address, idx, arr) => (
        <span key={address.address || idx}>
            <MailLink email={address.address} name={address.name} mailLink={!compact} compact={compact} />
            {idx < arr.length - 1 ? ', ' : ''}
        </span>
    ));
}

function formatContactObjects(contacts: AddressObject | AddressObject[], compact: boolean = false) {
    return Array.isArray(contacts)
        ? contacts.map((contact) => formatContactObject(contact, compact))
        : formatContactObject(contacts, compact);
}

// Collect the leaf recipients of a header field: normalise the ParsedMail AddressObject | AddressObject[]
// container, then expand RFC 2822 groups via the shared send-path helper so group members appear here too.
function collectRecipients(field?: AddressObject | AddressObject[]): { name: string; address: string }[] {
    const out: { name: string; address: string }[] = [];
    for (const obj of Array.isArray(field) ? field : field ? [field] : []) {
        flattenAddresses(obj.value, out);
    }
    return out;
}

function MailHeaderDetails({ email, formattedDate }: { email: Email; formattedDate: string }) {
    const rows: { label: string; node: ReactNode }[] = [];
    if (email.from) rows.push({ label: 'from', node: formatContactObjects(email.from) });
    if (email.replyTo) rows.push({ label: 'reply-to', node: formatContactObjects(email.replyTo) });
    if (email.to) rows.push({ label: 'to', node: formatContactObjects(email.to) });
    if (email.cc) rows.push({ label: 'cc', node: formatContactObjects(email.cc) });
    if (email.bcc) rows.push({ label: 'bcc', node: formatContactObjects(email.bcc) });
    rows.push({ label: 'date', node: <span className="text-foreground">{formattedDate}</span> });
    if (email.subject) rows.push({ label: 'subject', node: <span className="text-foreground">{email.subject}</span> });

    return (
        <div className="text-sm">
            {rows.map((r) => (
                <div key={r.label} className="grid grid-cols-[80px_1fr] gap-2 py-1">
                    <span className="text-muted-foreground">{r.label}:</span>
                    <span className="break-words">{r.node}</span>
                </div>
            ))}
        </div>
    );
}

function MailHeader({ email, formattedDate }: { email: Email; formattedDate: string }) {
    const isSent = email.mailbox === 'Sent';
    const recipients = [
        ...collectRecipients(email.to),
        ...collectRecipients(email.cc),
        ...collectRecipients(email.bcc),
    ];
    const primary = isSent ? recipients[0] : email.from?.value[0];
    const primaryName = primary?.name || primary?.address || 'Unknown';
    const primaryEmail = primary?.address || '';

    const summaryNames = recipients.map((a) => a.name || a.address || '').filter(Boolean);

    return (
        <div className="flex items-center">
            <UserAvatar name={primaryName} email={primaryEmail} />
            <div className="ml-3 flex-1 min-w-0">
                <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-sm font-medium text-foreground truncate">{primaryName}</span>
                    {primaryEmail && primaryEmail !== primaryName && (
                        <span className="text-xs text-muted-foreground truncate">&lt;{primaryEmail}&gt;</span>
                    )}
                </div>
                <div className="flex justify-between items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                    {summaryNames.length > 0 ? (
                        <Popover>
                            <PopoverTrigger asChild>
                                <button
                                    type="button"
                                    className="flex items-center gap-1 min-w-0 hover:text-foreground rounded cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    <span className="truncate">to: {summaryNames.join(', ')}</span>
                                    <ChevronDown className="h-3 w-3 shrink-0" />
                                </button>
                            </PopoverTrigger>
                            <PopoverContent
                                align="start"
                                collisionPadding={8}
                                className="w-[28rem] max-w-[calc(100vw-2rem)]"
                            >
                                <MailHeaderDetails email={email} formattedDate={formattedDate} />
                            </PopoverContent>
                        </Popover>
                    ) : (
                        <span />
                    )}
                    <span className="ml-auto shrink-0">{formattedDate}</span>
                </div>
            </div>
        </div>
    );
}

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

    const formattedDate = email.date ? formatDateTime(new Date(email.date)) : 'Unknown date';

    // Get email content
    const emailContent = email.html || email.textAsHtml || email.text || '';

    return (
        <div className="flex flex-col h-full bg-background">
            {/* y-scroll (not auto): the body's scale-to-fit reacts to pane width, so a scrollbar
                that comes and goes with the scaled height would oscillate on classic scrollbars. */}
            <div className="app-gutter flex-1 overflow-y-scroll" data-document="email-detail">
                <div className="space-y-4 mb-6">
                    <div>
                        <h1 className="text-xl font-medium mb-4">
                            {email.subject ? String(email.subject) : '(No subject)'}
                        </h1>

                        <MailHeader email={email} formattedDate={formattedDate} />
                    </div>

                    <Separator />

                    <ReadAttachments emailId={email.id} attachments={email.attachments} />

                    {/* Email body — left-aligned with the header, capped at the document reading
                        width (max-w-4xl, same as drive's editor and eigendoc preview) */}
                    <div className="prose prose-sm max-w-4xl">
                        {email.html || email.textAsHtml ? (
                            <ShadowContent
                                content={emailContent}
                                contentType="html"
                                scheme={email.html ? 'light' : 'theme'}
                                className="w-full"
                                highlightTerm={highlightTerm}
                            />
                        ) : (
                            <div style={{ whiteSpace: 'pre-wrap' }}>{emailContent}</div>
                        )}
                    </div>

                    {/* Calendar invite widgets */}
                    {email.attachments?.map(
                        (attachment: Attachment, index: number) =>
                            attachment.contentType.startsWith('text/calendar') && (
                                <CalendarInviteWidget key={index} invite={attachment.calendarInvite} />
                            ),
                    )}
                </div>
            </div>
        </div>
    );
}
