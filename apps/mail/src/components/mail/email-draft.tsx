import {ArrowLeft, Trash2, Send} from "lucide-react";
import {cn} from "@workspace/ui/lib/utils";
import {Button} from "@workspace/ui/components/button";
import {EmailDraft as EmailDraftType} from "@apps/api-server/types/mail";
import {TooltipButton} from "@workspace/ui";
import {Input} from "@workspace/ui/components/input";
import {Textarea} from "@workspace/ui/components/textarea";
import {useEffect, useRef, useState, useMemo} from "react";
import {toast} from "sonner";

interface EmailDraftProps {
    email: EmailDraftType | null;
    isMobile?: boolean;
    className?: string;
    onBackClick?: () => void;
    onDelete: (mail: EmailDraftType) => void;
    toggleMailRead: (mail: EmailDraftType, isRead: boolean) => void;
    sendDraft: (mail: EmailDraftType) => Promise<any>;
    updateDraft: (mail: EmailDraftType) => Promise<any>;
}

export function EmailDraft({
                               email,
                               isMobile,
                               className,
                               onBackClick,
                               onDelete,
                               toggleMailRead,
                               sendDraft,
                               updateDraft,
                               ...props
                           }: EmailDraftProps) {
    // Create refs for the input fields
    const toFieldRef = useRef<HTMLInputElement>(null);
    const subjectFieldRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const ccFieldRef = useRef<HTMLInputElement>(null);
    const bccFieldRef = useRef<HTMLInputElement>(null);
    const [isSending, setIsSending] = useState(false);

    if (!email) {
        console.log('No email provided to EmailDraft component');
        return (
            <div className="flex h-full items-center justify-center text-muted-foreground">
                Email data not available
            </div>
        );
    }

    console.log('Rendering EmailDraft with email:', email);

    // Get sender info
    const from = email.from?.value?.[0] || {
        name: '',
        address: '',
    };

    const fromName = from.name || from.address;
    const fromEmail = from.address;

    // Set focus on the appropriate field based on priority
    useEffect(() => {
        // Check if To field is empty by checking the defaultValue we're using in the input
        const toFieldEmpty = !email.to || email.to.html === '' || email.to.text === '';

        // Check if subject is empty
        const subjectEmpty = !email.subject || String(email.subject).trim() === '';

        if (toFieldEmpty && toFieldRef.current) {
            toFieldRef.current.focus();
        } else if (subjectEmpty && subjectFieldRef.current) {
            subjectFieldRef.current.focus();
        } else if (textareaRef.current) {
            textareaRef.current.focus();
        }
    }, [email]);

    // Create a function to get the current draft values
    const getCurrentDraft = useMemo(() => () => {
        const convertStringToEmailAddressArray = (field: string) => {
            if (!field || field.trim() === '') {
                return [];
            }
            // field can be a comma separated list of email addresses
            return field.split(',').map(value => {
                // value can be name <address> but also only address
                const [name, address] = value.split('<');
                if (!address) {
                    return {
                        name: '',
                        address: name.trim()
                    };
                }
                return {
                    name: name.trim(),
                    address: address.trim().replace('>', '')
                };
            });
        }

        return {
            ...email,
            to: toFieldRef.current?.value ? {
                value: convertStringToEmailAddressArray(toFieldRef.current?.value || ''),
                text: toFieldRef.current?.value || '',
                html: toFieldRef.current?.value || '',
            } : undefined,
            cc: ccFieldRef.current?.value ? {
                value: convertStringToEmailAddressArray(ccFieldRef.current?.value || ''),
                text: ccFieldRef.current?.value || '',
                html: ccFieldRef.current?.value || '',
            } : undefined,
            bcc: bccFieldRef.current?.value ? {
                value: convertStringToEmailAddressArray(bccFieldRef.current?.value || ''),
                text: bccFieldRef.current?.value || '',
                html: bccFieldRef.current?.value || '',
            } : undefined,
            subject: subjectFieldRef.current?.value || '',
            text: textareaRef.current?.value || ''
        };
    }, [email]);

    // Handle send email functionality
    const handleSendEmail = async () => {
        if (!email) return;

        // Validate the form
        const toValue = toFieldRef.current?.value.trim();
        if (!toValue) {
            toast.error("Please specify at least one recipient");
            toFieldRef.current?.focus();
            return;
        }

        try {
            setIsSending(true);

            // Use the current draft values
            const updatedDraft = getCurrentDraft();

            // Send the email
            await sendDraft(updatedDraft);
        } catch (error) {
            console.error("Failed to send email:", error);
            toast.error("Failed to send email. Please try again.");
        } finally {
            setIsSending(false);
        }
    };

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
                        onClick={handleSendEmail}
                        disabled={isSending}
                    />
                </div>
                <div className="flex items-center gap-2">
                    <TooltipButton
                        icon={Trash2}
                        tooltipText="Delete"
                        onClick={() => onDelete(email)}
                        disabled={isSending}
                    />
                </div>
            </div>

            {/* Email Form */}
            <div className="flex-1 overflow-auto">
                <form className="flex flex-col h-full" onSubmit={(e) => { e.preventDefault(); handleSendEmail(); }}>
                    <div className="space-y-1 px-4 py-2">

                        {/* To field */}
                        <div className="flex items-center border-b">
                            <div className="w-16 text-sm text-muted-foreground py-2">To:</div>
                            <Input
                                id="to"
                                ref={toFieldRef}
                                defaultValue={email.to?.text || ""}
                                className="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                                disabled={isSending}
                            />
                        </div>

                        {/* CC field */}
                        <div className="flex items-center border-b">
                            <div className="w-16 text-sm text-muted-foreground py-2">Cc:</div>
                            <Input
                                id="cc"
                                ref={ccFieldRef}
                                defaultValue={email.cc?.text || ""}
                                className="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                                disabled={isSending}
                            />
                        </div>

                        {/* BCC field */}
                        <div className="flex items-center border-b">
                            <div className="w-16 text-sm text-muted-foreground py-2">Bcc:</div>
                            <Input
                                id="bcc"
                                ref={bccFieldRef}
                                defaultValue={email.bcc?.text || ""}
                                className="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                                disabled={isSending}
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
                                ref={subjectFieldRef}
                                defaultValue={email.subject ? String(email.subject) : ""}
                                className="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                                disabled={isSending}
                            />
                        </div>
                    </div>

                    {/* Email body */}
                    <div className="flex-1 p-4">
                        <Textarea
                            className="w-full h-full min-h-[200px] border-none resize-none focus-visible:ring-0 bg-transparent p-0"
                            placeholder="Write your message here..."
                            defaultValue={email.text || ""}
                            ref={textareaRef}
                            disabled={isSending}
                        />
                    </div>
                </form>
            </div>
        </div>
    );
}
