import { formatFullDateTime } from '@workspace/lib/date';
import type { AddressObject, Attachment, Email, MaildirMailbox } from '@workspace/lib/types/mail';
import { Toolbar, TooltipButton } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@workspace/ui/components/dropdown-menu';
import { ShadowContent } from '@workspace/ui/components/layout/shadow-content';
import { UserItem } from '@workspace/ui/components/layout/user-item';
import { Separator } from '@workspace/ui/components/separator';
import { Table, TableBody, TableCell, TableRow } from '@workspace/ui/components/table';
import { printDocument } from '@workspace/ui/lib/printElement';
import { AlertTriangle, Archive, Forward, MoreVertical, Reply, ReplyAll, Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
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
                <div className="h-6 w-[1px] bg-border mx-1" />
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8" title="More actions">
                            <MoreVertical className="h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
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
                    <a
                        className="hover:underline"
                        href={`${import.meta.env.VITE_APP_MAIL_URL}/box/inbox?mode=compose&to=${email}`}
                        title={email}
                    >
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

export function EmailDetail({ email, toggleMailRead }: EmailDetailProps) {
    const hasMarkedAsRead = useRef<string | null>(null);

    useEffect(() => {
        if (email && !email.isRead && hasMarkedAsRead.current !== email.id) {
            hasMarkedAsRead.current = email.id;
            toggleMailRead(email, true);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- toggleMailRead is an unstable prop reference; hasMarkedAsRead ref prevents re-marking
    }, [email]);

    if (!email) {
        return (
            <div className="flex h-full items-center justify-center text-muted-foreground">
                Email data not available
            </div>
        );
    }

    const firstFrom = email.from?.value[0];
    const fromName = firstFrom?.name || firstFrom?.address || 'Unknown';
    const fromEmail = firstFrom?.address || 'unknown@example.com';

    const needsToShowTo = email.to
        ? Array.isArray(email.to)
            ? email.to.length > 1
            : email.to.value.length > 1
        : false;
    const needsToShowCc = email.cc
        ? Array.isArray(email.cc)
            ? email.cc.length > 1
            : email.cc.value.length > 1
        : false;
    const needsToShowBcc = email.bcc
        ? Array.isArray(email.bcc)
            ? email.bcc.length > 1
            : email.bcc.value.length > 1
        : false;

    const needsToShowDetails = needsToShowTo || needsToShowCc || needsToShowBcc;

    const formattedDate = email.date ? formatFullDateTime(new Date(email.date)) : 'Unknown date';

    // Get email content
    const emailContent = email.html || email.textAsHtml || email.text || '';

    return (
        <div className="flex flex-col h-full bg-background">
            <div className="p-4 flex-1 overflow-auto" data-document="email-detail">
                {/* Email header */}
                <div className="space-y-4 mb-6">
                    <div>
                        <h1 className="text-xl font-semibold mb-4">
                            {email.subject ? String(email.subject) : '(No subject)'}
                        </h1>

                        <div className="mt-4 ">
                            <UserItem name={fromName} email={fromEmail} label={formattedDate} mailLink={true} />
                        </div>
                    </div>

                    {needsToShowDetails && (
                        <details className="group">
                            <summary className="text-xs truncate p-1 cursor-pointer hover:bg-muted rounded-md">
                                <span className="opacity-100 group-open:opacity-0">
                                    {needsToShowTo && email.to && <> to: {formatContactObjects(email.to, true)}</>}
                                    {needsToShowCc && email.cc && <> cc: {formatContactObjects(email.cc, true)}</>}
                                    {needsToShowBcc && email.bcc && <> bcc: {formatContactObjects(email.bcc, true)}</>}
                                </span>
                            </summary>
                            <div>
                                <Table className="text-sm text-muted-foreground">
                                    <TableBody>
                                        <TableRow className="border-none">
                                            <TableCell className="text-xs w-10 px-1 py-1">From</TableCell>
                                            <TableCell className="truncate px-1 py-1">
                                                {email.from && formatContactObjects(email.from)}
                                            </TableCell>
                                        </TableRow>
                                        {needsToShowTo ? (
                                            <TableRow className="border-none">
                                                <TableCell className="text-xs w-10 px-1 py-1">To</TableCell>
                                                <TableCell className="truncate px-1 py-1">
                                                    {email.to && formatContactObjects(email.to)}
                                                </TableCell>
                                            </TableRow>
                                        ) : null}
                                        {needsToShowCc && email.cc ? (
                                            <TableRow className="border-none">
                                                <TableCell className="text-xs px-1 py-1">Cc</TableCell>
                                                <TableCell className="truncate px-1 py-1">
                                                    {email.cc && formatContactObjects(email.cc)}
                                                </TableCell>
                                            </TableRow>
                                        ) : null}
                                        {needsToShowBcc && email.bcc ? (
                                            <TableRow className="border-none">
                                                <TableCell className="text-xs px-1 py-1">Bcc</TableCell>
                                                <TableCell className="truncate px-1 py-1">
                                                    {formatContactObjects(email.bcc)}
                                                </TableCell>
                                            </TableRow>
                                        ) : null}
                                    </TableBody>
                                </Table>
                            </div>
                        </details>
                    )}

                    <Separator />

                    <ReadAttachments emailId={email.id} attachments={email.attachments} />

                    {/* Email body */}
                    <div className="prose prose-sm max-w-none">
                        {email.html || email.textAsHtml ? (
                            <ShadowContent content={emailContent} contentType="html" className="w-full" />
                        ) : (
                            <div style={{ whiteSpace: 'pre-wrap' }}>{emailContent}</div>
                        )}
                    </div>

                    {/* Calendar invite widgets */}
                    {email.attachments?.map(
                        (attachment: Attachment, index: number) =>
                            attachment.contentType.startsWith('text/calendar') && (
                                <CalendarInviteWidget
                                    key={index}
                                    attachment={attachment}
                                    emailId={email.id}
                                    attachmentIndex={index}
                                />
                            ),
                    )}
                </div>
            </div>
        </div>
    );
}
