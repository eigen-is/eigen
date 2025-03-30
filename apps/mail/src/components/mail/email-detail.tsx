import {Archive, ArchiveX, ArrowLeft, Forward, MoreVertical, Paperclip, Reply, ReplyAll, Trash2} from "lucide-react";
import {cn} from "@workspace/ui/lib/utils";
import {Button} from "@workspace/ui/components/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@workspace/ui/components/dropdown-menu";
import {format} from "date-fns";
import {Email} from "@apps/api-server/types/mail";
import {Separator} from "@workspace/ui/components/separator";
import {ShadowContent} from "@workspace/ui/components/layout/shadow-content";
import {UserItem} from "@workspace/ui/components/layout/user-item";
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from "@workspace/ui/components/tooltip";

interface EmailDetailProps {
    email: Email | null;
    isMobile?: boolean;
    className?: string;
    onBackClick?: () => void;
    onDelete: (mail: Email) => void;
    toggleMailRead: (mail: Email, isRead: boolean) => void;
}

export function EmailDetail({
                                email,
                                isMobile,
                                className,
                                onBackClick,
                                onDelete,
                                toggleMailRead,
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
                    <Button variant="ghost" size="icon" className="h-8 w-8" title="Archive">
                        <Archive className="h-4 w-4"/>
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" title="Junk">
                        <ArchiveX className="h-4 w-4"/>
                    </Button>
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onDelete(email)}
                                >
                                    <Trash2 className="h-4 w-4"/>
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>Move to Trash</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                </div>

                <div className="flex items-center gap-1">
                    {/* Right side icons */}
                    <Button variant="ghost" size="icon" className="h-8 w-8" title="Reply">
                        <Reply className="h-4 w-4"/>
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" title="Reply All">
                        <ReplyAll className="h-4 w-4"/>
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" title="Forward">
                        <Forward className="h-4 w-4"/>
                    </Button>

                    <div className="h-6 w-[1px] bg-border mx-1"></div>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" title="More actions">
                                <MoreVertical className="h-4 w-4"/>
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem>Mark as unread</DropdownMenuItem>
                            <DropdownMenuItem>Move to folder</DropdownMenuItem>
                            <DropdownMenuItem>Add label</DropdownMenuItem>
                            <DropdownMenuItem>Print</DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>

            {/* Email content */}
            <div className="p-4 flex-1 overflow-auto">
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
                                        className="flex items-center p-3 border rounded-md hover:bg-muted/50 cursor-pointer"
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
