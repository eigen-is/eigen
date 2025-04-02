import {ArrowLeft, Paperclip, Trash2, Send} from "lucide-react";
import {cn} from "@workspace/ui/lib/utils";
import {Button} from "@workspace/ui/components/button";
import {format} from "date-fns";
import {Email} from "@apps/api-server/types/mail";
import {TooltipButton} from "@workspace/ui";
import {Input} from "@workspace/ui/components/input";
import {Textarea} from "@workspace/ui/components/textarea";

interface EmailDraftProps {
    email: Email | null;
    isMobile?: boolean;
    className?: string;
    onBackClick?: () => void;
    onDelete: (mail: Email) => void;
    toggleMailRead: (mail: Email, isRead: boolean) => void;
}

export function EmailDraft({
                               email,
                               isMobile,
                               className,
                               onBackClick,
                               onDelete,
                               toggleMailRead,
                               ...props
                           }: EmailDraftProps) {
    if (!email) {
        console.log('No email provided to EmailDraft component');
        return (
            <div className="flex h-full items-center justify-center text-muted-foreground">
                Email data not available
            </div>
        );
    }

    toggleMailRead(email, true);

    console.log('Rendering EmailDraft with email:', email);

    // Get sender info
    const from = email.from?.value?.[0] || {
        name: '',
        address: '',
    };

    const fromName = from.name || from.address;
    const fromEmail = from.address;

    // Format date
    const date = email.date ? new Date(email.date) : new Date();
    const formattedDate = format(date, 'MMM d, yyyy h:mm a');

    // Email content
    const emailContent = email.html || email.textAsHtml || email.text || '';

    return (
        <div className={cn("flex flex-col h-full w-full", className)}>
            {/* Header */}
            <div className="flex items-center justify-between h-12 border-b px-4">
                <div className="flex items-center">
                    {isMobile && (
                        <Button variant="ghost" size="icon" onClick={onBackClick}
                                className="mr-2">
                            <ArrowLeft className="h-5 w-5"/>
                            <span className="sr-only">Back</span>
                        </Button>
                    )}
                    <TooltipButton
                        icon={Send}
                        tooltipText="Send"
                        onClick={() => console.log('Send email')}
                    />
                </div>
                <div className="flex items-center gap-2">
                    <TooltipButton
                        icon={Trash2}
                        tooltipText="Delete"
                        onClick={() => onDelete(email)}
                    />
                </div>
            </div>

            {/* Email Form */}
            <div className="flex-1 overflow-auto">
                <form className="flex flex-col h-full">
                    <div className="space-y-1 px-4 py-2">
                        
                        {/* To field */}
                        <div className="flex items-center border-b">
                            <div className="w-16 text-sm text-muted-foreground py-2">To:</div>
                            <Input 
                                id="to" 
                                defaultValue={email.to?.text || ""}
                                className="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                            />
                        </div>
                        
                        {/* CC field */}
                        <div className="flex items-center border-b">
                            <div className="w-16 text-sm text-muted-foreground py-2">Cc:</div>
                            <Input 
                                id="cc" 
                                defaultValue={email.cc?.text || ""}
                                className="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                            />
                        </div>
                        
                        {/* BCC field */}
                        <div className="flex items-center border-b">
                            <div className="w-16 text-sm text-muted-foreground py-2">Bcc:</div>
                            <Input 
                                id="bcc" 
                                defaultValue={email.bcc?.text || ""}
                                className="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                            />
                        </div>

                        {/* From field (non-editable) */}
                        <div className="flex items-center border-b">
                            <div className="w-16 text-sm text-muted-foreground py-2">From:</div>
                            <Input 
                                id="from" 
                                value={`${fromName} <${fromEmail}>`} 
                                disabled 
                                className="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                            />
                        </div>
                        
                        {/* Subject field */}
                        <div className="flex items-center border-b">
                            <div className="w-16 text-sm text-muted-foreground py-2">Subject:</div>
                            <Input 
                                id="subject" 
                                defaultValue={email.subject ? String(email.subject) : ""}
                                className="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                            />
                        </div>
                    </div>
                    
                    {/* Email body */}
                    <div className="flex-1 p-4">
                        <Textarea 
                            className="w-full h-full min-h-[200px] border-none resize-none focus-visible:ring-0 bg-transparent p-0"
                            placeholder="Write your message here..."
                            defaultValue={email.text || ""}
                        />
                    </div>
                </form>
            </div>
        </div>
    );
}
