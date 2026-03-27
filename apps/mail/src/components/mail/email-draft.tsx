import {EmailDraft as EmailDraftType} from "@workspace/lib/types/mail";
import {ContactAutosuggest, Toolbar, TooltipButton} from "@workspace/ui";
import {ConfirmDialog} from "@workspace/ui/components/layout/delete/confirm-dialog";
import {Input} from "@workspace/ui/components/input";
import {Textarea} from "@workspace/ui/components/textarea";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {toast} from "sonner";
import {createDraftEmail} from "@workspace/lib/mail";
import {useAuth} from "@workspace/lib/auth";
import {Send, Trash2} from "lucide-react";

/**
 * Checks the status of an email draft
 * @param draft The email draft to check
 * @returns Object with sendable and saveable status
 */
export function getEmailDraftStatus(draft: EmailDraftType) {
    // Check if draft is sendable (to field is not empty)
    const isSendable = !!(draft.to &&
        draft.to.text &&
        draft.to.text.trim() !== '');

    // Check if draft is saveable (at least one of subject, to, cc, bcc, or text is not empty)
    const isSaveable = !!(
        (draft.subject && draft.subject.toString().trim() !== '') ||
        (draft.to && draft.to.text && draft.to.text.trim() !== '') ||
        (draft.cc && draft.cc.text && draft.cc.text.trim() !== '') ||
        (draft.bcc && draft.bcc.text && draft.bcc.text.trim() !== '') ||
        (draft.text && draft.text.trim() !== '')
    );

    return {isSendable, isSaveable};
}

export function EmailDraftToolbar({onDelete, isSending, hasId}: {
    onDelete: () => void;
    isSending: boolean;
    hasId: boolean;
}) {
    return (
        <Toolbar>
            <TooltipButton
                icon={Send}
                tooltipText="Send"
                type="submit"
                form="draft-form"
                disabled={isSending}
            />
            {hasId && (
                <TooltipButton
                    icon={Trash2}
                    tooltipText="Delete"
                    onClick={onDelete}
                    disabled={isSending}
                />
            )}
        </Toolbar>
    );
}

type EmailDraftProps = {
    email: EmailDraftType | null;
    to?: string;
    onDelete: (mail: EmailDraftType) => void;
    sendDraft: (mail: EmailDraftType) => Promise<any>;
    onAutoSave?: (mail: EmailDraftType) => Promise<any>;
}

export function EmailDraft({
                               email,
                               to,
                               onDelete,
                               sendDraft,
                               onAutoSave,
                           }: EmailDraftProps) {
    // Create refs for the input fields
    const toFieldRef = useRef<HTMLInputElement>(null);
    const subjectFieldRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const ccFieldRef = useRef<HTMLInputElement>(null);
    const bccFieldRef = useRef<HTMLInputElement>(null);
    const [isSending, setIsSending] = useState(false);
    const [confirmNoSubject, setConfirmNoSubject] = useState(false);

    const auth = useAuth();

    const draft = useMemo(() => {
        const d = email ?? createDraftEmail({});
        return {
            ...d,
            from: {
                value: [{name: auth.user!.name || '', address: auth.user!.email || ''}],
                html: '', text: '',
            },
            ...(to ? {to: {value: [{name: '', address: to}], html: to, text: to}} : {}),
        };
    }, [email, to, auth.user]);

    const fromName = draft.from?.value[0].name || draft.from?.value[0].address;
    const fromEmail = draft.from?.value[0].address;

    // Set focus on the appropriate field based on priority
    useEffect(() => {
        // Check if To field is empty by checking the defaultValue we're using in the input
        const toFieldEmpty = !draft.to || draft.to.html === '' || draft.to.text === '';

        // Check if subject is empty
        const subjectEmpty = !draft.subject || String(draft.subject).trim() === '';

        if (toFieldEmpty && toFieldRef.current) {
            toFieldRef.current.focus();
        } else if (subjectEmpty && subjectFieldRef.current) {
            subjectFieldRef.current.focus();
        } else if (textareaRef.current) {
            textareaRef.current.focus();
        }
    }, [draft]);

    // Create a function to get the current draft values
    const getCurrentDraft = useCallback(() => {
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
            ...draft,
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
    }, [draft]);

    // Save draft on unmount (navigation away / page leave)
    const onAutoSaveRef = useRef(onAutoSave);
    onAutoSaveRef.current = onAutoSave;
    useEffect(() => {
        if (!email?.id) return;
        return () => {
            onAutoSaveRef.current?.(getCurrentDraft()).catch(() => {
            });
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- save on unmount only
    }, [email?.id]);

    const doSend = async () => {
        try {
            setIsSending(true);
            await sendDraft(getCurrentDraft());
        } finally {
            setIsSending(false);
        }
    };

    const handleSendEmail = async () => {
        const toValue = toFieldRef.current?.value.trim();
        if (!toValue) {
            toast.error("Please specify at least one recipient");
            toFieldRef.current?.focus();
            return;
        }

        const subjectEmpty = !subjectFieldRef.current?.value.trim();
        const bodyEmpty = !textareaRef.current?.value.trim();

        if (subjectEmpty && bodyEmpty) {
            toast.error("Please add a subject or message");
            subjectFieldRef.current?.focus();
            return;
        }

        if (subjectEmpty) {
            setConfirmNoSubject(true);
            return;
        }

        await doSend();
    };

    return (
        <div className="flex flex-col h-full w-full">
            {/* Email Form */}
            <div className="flex-1 overflow-auto">
                <form id="draft-form" className="flex flex-col h-full" onSubmit={(e) => {
                    e.preventDefault();
                    handleSendEmail();
                }}>
                    <div className="space-y-1 px-4 py-2">

                        {/* To field */}
                        <div className="flex items-center border-b">
                            <div className="w-16 text-sm text-muted-foreground py-2">To:</div>
                            <ContactAutosuggest
                                initialValue={draft.to?.text || ""}
                                onChange={() => {
                                    // Value is read from ref on submit
                                }}
                                appendMode={true}
                                className="flex-1"
                                inputClassName="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                                inputRef={toFieldRef}
                                disabled={isSending}
                                autoComplete="off"
                                id="to"
                            />
                        </div>

                        {/* CC field */}
                        <div className="flex items-center border-b">
                            <div className="w-16 text-sm text-muted-foreground py-2">Cc:</div>
                            <ContactAutosuggest
                                initialValue={draft.cc?.text || ""}
                                onChange={() => {
                                    // Value is read from ref on submit
                                }}
                                appendMode={true}
                                className="flex-1"
                                inputClassName="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                                inputRef={ccFieldRef}
                                disabled={isSending}
                                autoComplete="off"
                                id="cc"
                            />
                        </div>

                        {/* BCC field */}
                        <div className="flex items-center border-b">
                            <div className="w-16 text-sm text-muted-foreground py-2">Bcc:</div>
                            <ContactAutosuggest
                                initialValue={draft.bcc?.text || ""}
                                onChange={() => {
                                    // Value is read from ref on submit
                                }}
                                appendMode={true}
                                className="flex-1"
                                inputClassName="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                                inputRef={bccFieldRef}
                                disabled={isSending}
                                autoComplete="off"
                                id="bcc"
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
                                defaultValue={draft.subject ? String(draft.subject) : ""}
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
                            defaultValue={draft.text || ""}
                            ref={textareaRef}
                            disabled={isSending}
                        />
                    </div>
                </form>
            </div>
            <ConfirmDialog
                open={confirmNoSubject}
                onOpenChange={setConfirmNoSubject}
                title="Send without subject?"
                description="This message has no subject. Send anyway?"
                confirmText="Send"
                onConfirm={() => {
                    setConfirmNoSubject(false);
                    doSend();
                }}
            />
        </div>
    );
}
