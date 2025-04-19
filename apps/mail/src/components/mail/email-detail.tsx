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
import {Email, MaildirMailbox} from "@apps/api-server/types/mail";
import {ShadowContent} from "@workspace/ui/components/layout/shadow-content";
import {UserItem} from "@workspace/ui/components/layout/user-item";
import {TooltipButton} from "@workspace/ui";
import {Separator} from "@workspace/ui/components/separator";
import {EmailContextMenu} from "./email-context-menu";

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
    if (!email) {
        console.log('No email provided to EmailDetail component');
        return (
            <div className="flex h-full items-center justify-center text-muted-foreground">
                Email data not available
            </div>
        );
    }

    toggleMailRead(email, true);

    console.log('Rendering EmailDetail with email:', email);

    const firstFrom = email.from?.value[0];
    const fromName = firstFrom?.name || firstFrom?.address || 'Unknown';
    const fromEmail = firstFrom?.address || 'unknown@example.com';

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
                            <Button variant="ghost" size="icon" className="h-8 w-8" title="More actions">
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

                        <div className="mt-4">
                            <UserItem
                                name={fromName}
                                email={fromEmail}
                                label={formattedDate}
                            />
                        </div>
                    </div>

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
                                {email.attachments.map((attachment: any, index: number) => (
                                    <div
                                        key={index}
                                        className="flex items-center p-3 border rounded-md hover:bg-muted/50 cursor-pointer select-none"
                                        onClick={() => {
                                            const fileName = attachment.filename || `Attachment ${index + 1}`;
                                            const downloadUrl = `${import.meta.env.VITE_API_HOST}/mail/message/${email.id}/attachment/${index}/${encodeURIComponent(fileName)}`;

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
