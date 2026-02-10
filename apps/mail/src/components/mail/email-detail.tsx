import {
    AlertTriangle,
    Archive,
    ArrowLeft,
    Forward,
    MoreVertical,
    Paperclip,
    Reply,
    ReplyAll,
    Trash2
} from "lucide-react";
import {cn} from "@workspace/ui/lib/utils";
import {Button} from "@workspace/ui/components/button";
import {DropdownMenu, DropdownMenuTrigger} from "@workspace/ui/components/dropdown-menu";
import {format} from "date-fns";
import {AddressObject, Attachment, Email, MaildirMailbox} from "@workspace/lib/types/mail";
import {ShadowContent} from "@workspace/ui/components/layout/shadow-content";
import {UserItem} from "@workspace/ui/components/layout/user-item";
import {TooltipButton} from "@workspace/ui";
import {Separator} from "@workspace/ui/components/separator";
import {getMailAttachmentUrl} from "@workspace/lib/api";
import {EmailContextMenu} from "./email-context-menu";
import {printDocument} from "@workspace/ui/lib/printElement";
import {Table, TableBody, TableCell, TableRow} from "@workspace/ui/components/table";
import {useEffect, useRef} from "react";

interface EmailDetailProps {
    email: Email | null;
    isMobile?: boolean;
    className?: string;
    onBackClick?: () => void;
    toggleMailRead: (mail: Email, isRead: boolean) => void;
    onReply?: (emailId: string) => void;
    onReplyAll?: (emailId: string) => void;
    onForward?: (emailId: string) => void;
    onArchive?: (emailId: string) => void;
    onReportSpam?: (emailId: string) => void;
    onDelete?: (emailId: string) => void;
    onMoveToFolder?: (emailId: string, folderId: string) => void;
    mailboxes?: MaildirMailbox[];
}

export function MailLink({email, name, mailLink = true, compact = false}: {
    email?: string,
    name: string,
    mailLink?: boolean,
    compact?: boolean
}) {

    let label = name && email ? (<>{name} &lt;{email}&gt;</>) : (email ?? undefined);
    if (compact) {
        label = email ?? undefined;
    }
    return email && (
        <span className="text-xs text-gray-500">
            {mailLink ?
                <a
                    className="hover:underline"
                    href={`${import.meta.env.VITE_APP_MAIL_URL}/box/inbox?mode=compose&to=${email}`}
                    title={email}
                >
                    {label}
                </a>
                : (label)}
        </span>)
}

export function EmailDetail({
                                email,
                                isMobile,
                                className,
                                onBackClick,
                                toggleMailRead,
                                onReply,
                                onReplyAll,
                                onForward,
                                onArchive,
                                onReportSpam,
                                onDelete,
                                onMoveToFolder,
                                mailboxes = [],
                                ...props
                            }: EmailDetailProps) {
    const hasMarkedAsRead = useRef<string | null>(null);

    useEffect(() => {
        if (email && !email.isRead && hasMarkedAsRead.current !== email.id) {
            hasMarkedAsRead.current = email.id;
            toggleMailRead(email, true);
        }
    }, [email, toggleMailRead]);

    if (!email) {
        return (
            <div className="flex h-full items-center justify-center text-muted-foreground">
                Email data not available
            </div>
        );
    }

    console.log('Rendering EmailDetail with email:', email);

    const firstFrom = email.from?.value[0];
    const fromName = firstFrom?.name || firstFrom?.address || 'Unknown';
    const fromEmail = firstFrom?.address || 'unknown@example.com';

    const needsToShowTo = email.to ? (Array.isArray(email.to) ? email.to.length > 1 : email.to.value.length > 1) : false;
    const needsToShowCc = email.cc ? (Array.isArray(email.cc) ? email.cc.length > 1 : email.cc.value.length > 1) : false;
    const needsToShowBcc = email.bcc ? (Array.isArray(email.bcc) ? email.bcc.length > 1 : email.bcc.value.length > 1) : false;

    const needsToShowDetails = needsToShowTo || needsToShowCc || needsToShowBcc;


    // Format date
    let formattedDate = 'Unknown date';
    try {
        if (email.date) {
            const dateValue = new Date(email.date);
            formattedDate = format(dateValue, "MMMM d, yyyy 'at' h:mm a");
        }
    } catch (error) {
        console.error('Error formatting date:', error);
    }

    // Get email content
    const emailContent = email.html || email.textAsHtml || email.text || '';

    const formatContactObjects = (contacts: AddressObject | AddressObject[], compact: boolean = false) => {
        return Array.isArray(contacts) ? contacts.map((contact) => formatContactObject(contact, compact)) : formatContactObject(contacts, compact);
    };

    const formatContactObject = (contact: AddressObject, compact: boolean = false) => {
        return contact.value.map((address, idx, arr) => (<><MailLink email={address.address} name={address.name}
                                                                     mailLink={!compact}
                                                                     compact={compact}/>{idx < arr.length - 1 ? ', ' : ''}</>));
    };

    return (
        <div className={cn("flex flex-col h-full bg-white", className)} {...props}>
            {/* Action toolbar */}
            <div className="h-12 flex items-center justify-between px-4 border-b">
                <div className="flex items-center gap-1">
                    {/* Mobile back button when needed */}
                    {isMobile && onBackClick && (
                        <>
                            <Button variant="ghost" size="icon" className="h-8 w-8 mr-1" onClick={onBackClick}
                                    title="Back">
                                <ArrowLeft className="h-4 w-4"/>
                            </Button>
                            <div className="h-6 w-[1px] bg-border mx-1"></div>
                        </>
                    )}

                    {/* Left side icons */}
                    {email.mailbox !== 'archive' && (
                        <TooltipButton
                            icon={Archive}
                            tooltipText="Archive"
                            onClick={() => onArchive && onArchive(email.id)}
                        />
                    )}
                    {email.mailbox !== 'spam' && (
                        <TooltipButton
                            icon={AlertTriangle}
                            tooltipText="Report Spam"
                            onClick={() => onReportSpam && onReportSpam(email.id)}
                        />
                    )}
                    <TooltipButton
                        icon={Trash2}
                        tooltipText="Delete"
                        onClick={() => onDelete && onDelete(email.id)}
                    />
                </div>

                <div className="flex items-center gap-1">
                    {/* Right side icons */}
                    <TooltipButton
                        icon={Reply}
                        tooltipText="Reply"
                        onClick={() => onReply && onReply(email.id)}
                    />
                    <TooltipButton
                        icon={ReplyAll}
                        tooltipText="Reply All"
                        onClick={() => onReplyAll && onReplyAll(email.id)}
                    />
                    <TooltipButton
                        icon={Forward}
                        tooltipText="Forward"
                        onClick={() => onForward && onForward(email.id)}
                    />

                    <div className="h-6 w-[1px] bg-border mx-1"></div>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" className="w-full justify-start px-2 py-1.5" title="More actions">
                                <MoreVertical className="h-4 w-4"/>
                            </Button>
                        </DropdownMenuTrigger>
                        <EmailContextMenu
                            style={{}}
                            messageId={email.id}
                            mailboxes={mailboxes}
                            currentMailboxId={email.mailbox}
                            onReply={onReply}
                            onReplyAll={onReplyAll}
                            onForward={onForward}
                            onArchive={onArchive}
                            onReportSpam={onReportSpam}
                            onDelete={onDelete}
                            onMoveToFolder={onMoveToFolder}
                            onClose={() => {
                            }}
                            onPrint={(emailId) => {
                                console.log('Printing email:', emailId);
                                printDocument();
                            }}
                        />
                    </DropdownMenu>
                </div>
            </div>

            {/* Email content */}
            <div className="p-4 flex-1 overflow-auto" data-document>
                {/* Email header */}
                <div className="space-y-4 mb-6">
                    <div>
                        <h1 className="text-xl font-semibold mb-4">
                            {email.subject ? String(email.subject) : '(No subject)'}
                        </h1>

                        <div className="mt-4 ">
                            <UserItem
                                name={fromName}
                                email={fromEmail}
                                label={formattedDate}
                                mailLink={true}
                            />
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
                                        {(needsToShowCc && email.cc) ? (
                                            <TableRow className="border-none">
                                                <TableCell className="text-xs px-1 py-1">Cc</TableCell>
                                                <TableCell className="truncate px-1 py-1">
                                                    {email.cc && formatContactObjects(email.cc)}
                                                </TableCell>
                                            </TableRow>
                                        ) : null}
                                        {(needsToShowBcc && email.bcc) ? (
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

                    <Separator/>

                    {/* Email body */}
                    <div className="prose prose-sm max-w-none">
                        {email.html || email.textAsHtml ? (
                            <ShadowContent
                                content={emailContent}
                                contentType="html"
                                className="w-full"
                            />
                        ) : (
                            <div style={{whiteSpace: 'pre-wrap'}}>
                                {emailContent}
                            </div>
                        )}
                    </div>

                    {/* Attachments */}
                    {email.attachments && email.attachments.length > 0 && (
                        <div className="mt-6 pt-6 border-t">
                            <h3 className="font-medium mb-3 flex items-center gap-2">
                                <Paperclip className="h-4 w-4"/>
                                Attachments ({email.attachments.length})
                            </h3>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {email.attachments.map((attachment: Attachment, index: number) => (
                                    <div
                                        key={index}
                                        className="flex items-center p-3 border rounded-md hover:bg-muted/50 cursor-pointer select-none"
                                        onClick={() => {
                                            const fileName = attachment.filename || `Attachment ${index + 1}`;
                                            const downloadUrl = getMailAttachmentUrl(email.id, index, fileName);

                                            // Create a temporary anchor element to trigger the download
                                            const a = document.createElement('a');
                                            a.href = downloadUrl;
                                            a.download = fileName;
                                            document.body.appendChild(a);
                                            a.click();
                                            document.body.removeChild(a);
                                        }}
                                    >
                                        <Paperclip className="h-4 w-4 mr-2 text-muted-foreground"/>
                                        <span className="text-sm truncate">
                                            {attachment.filename || `Attachment ${index + 1}`}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
