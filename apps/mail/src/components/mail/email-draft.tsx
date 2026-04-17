import { useAuth } from '@workspace/lib/auth';
import type { EmailDraft as EmailDraftType, NewDraft } from '@workspace/lib/types/mail';
import { ContactAutosuggest, Toolbar, TooltipButton } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { ConfirmDialog } from '@workspace/ui/components/layout/delete/confirm-dialog';
import { LightEditor } from '@workspace/ui/components/layout/editor';
import { Send, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDraftAutoSave } from './hooks/use-draft-auto-save';
import { useDraftState } from './hooks/use-draft-state';

export function EmailDraftToolbar({
    onDelete,
    isSending,
    hasId,
}: {
    onDelete: () => void;
    isSending: boolean;
    hasId: boolean;
}) {
    return (
        <Toolbar>
            <TooltipButton icon={Send} tooltipText="Send" type="submit" form="draft-form" disabled={isSending} />
            {hasId && <TooltipButton icon={Trash2} tooltipText="Delete" onClick={onDelete} disabled={isSending} />}
        </Toolbar>
    );
}

type EmailDraftProps = {
    email: EmailDraftType | null;
    to?: string;
    sendDraft: (mail: NewDraft | EmailDraftType) => Promise<unknown>;
    onAutoSave?: (mail: NewDraft | EmailDraftType) => Promise<unknown>;
    isSending: boolean;
};

export function EmailDraft({ email, to, sendDraft, onAutoSave, isSending }: EmailDraftProps) {
    const [alertMessage, setAlertMessage] = useState<string | null>(null);
    const [confirmNoSubject, setConfirmNoSubject] = useState(false);
    const auth = useAuth();

    const { state, setField, toDraft, isSendable, isSaveable } = useDraftState(email, to);

    const { scheduleSave } = useDraftAutoSave({
        toDraft,
        isSaveable,
        draftId: state.id,
        onSave: onAutoSave || (() => Promise.resolve()),
        onIdAssigned: (id) => setField('id', id),
    });

    const fromName = auth.user?.name || auth.user?.email || '';
    const fromEmail = auth.user?.email || '';

    useEffect(() => {
        scheduleSave();
    }, [state.to, state.cc, state.bcc, state.subject, state.body, scheduleSave]);

    const handleSendEmail = async () => {
        if (!isSendable) {
            setAlertMessage('Please specify at least one recipient.');
            return;
        }
        if (!state.subject.trim() && !state.body.trim()) {
            setAlertMessage('Please add a subject or message.');
            return;
        }
        if (!state.subject.trim()) {
            setConfirmNoSubject(true);
            return;
        }
        await sendDraft(toDraft());
    };

    return (
        <div className="flex flex-col h-full w-full">
            <div className="flex-1 overflow-auto">
                <form
                    id="draft-form"
                    className="flex flex-col h-full"
                    onSubmit={(e) => {
                        e.preventDefault();
                        handleSendEmail();
                    }}
                >
                    <div className="space-y-1 px-4 py-2">
                        <div className="flex items-center border-b">
                            <div className="w-16 text-sm text-muted-foreground py-2">To:</div>
                            <ContactAutosuggest
                                initialValue={state.to}
                                onChange={(val) => setField('to', val)}
                                appendMode
                                className="flex-1"
                                inputClassName="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                                disabled={isSending}
                                autoComplete="off"
                                id="to"
                            />
                        </div>
                        <div className="flex items-center border-b">
                            <div className="w-16 text-sm text-muted-foreground py-2">Cc:</div>
                            <ContactAutosuggest
                                initialValue={state.cc}
                                onChange={(val) => setField('cc', val)}
                                appendMode
                                className="flex-1"
                                inputClassName="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                                disabled={isSending}
                                autoComplete="off"
                                id="cc"
                            />
                        </div>
                        <div className="flex items-center border-b">
                            <div className="w-16 text-sm text-muted-foreground py-2">Bcc:</div>
                            <ContactAutosuggest
                                initialValue={state.bcc}
                                onChange={(val) => setField('bcc', val)}
                                appendMode
                                className="flex-1"
                                inputClassName="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                                disabled={isSending}
                                autoComplete="off"
                                id="bcc"
                            />
                        </div>
                        <div className="flex items-center border-b">
                            <div className="w-16 text-sm text-muted-foreground py-2">From:</div>
                            <Input
                                id="from"
                                value={`${fromName} <${fromEmail}>`}
                                disabled
                                className="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                            />
                        </div>
                        <div className="flex items-center border-b">
                            <div className="w-16 text-sm text-muted-foreground py-2">Subject:</div>
                            <Input
                                id="subject"
                                value={state.subject}
                                onChange={(e) => setField('subject', e.target.value)}
                                className="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                                disabled={isSending}
                            />
                        </div>
                    </div>
                    <div className="flex-1 p-4">
                        <LightEditor
                            content={state.body}
                            onChange={(html) => setField('body', html)}
                            placeholder="Write your message here..."
                            toolbar="floating"
                            className="w-full min-h-[200px]"
                            editable={!isSending}
                        />
                    </div>
                </form>
            </div>
            <Dialog open={!!alertMessage} onOpenChange={() => setAlertMessage(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Cannot send</DialogTitle>
                        <DialogDescription>{alertMessage}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button onClick={() => setAlertMessage(null)}>OK</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            <ConfirmDialog
                open={confirmNoSubject}
                onOpenChange={setConfirmNoSubject}
                title="Send without subject?"
                description="This message has no subject. Send anyway?"
                confirmText="Send"
                onConfirm={() => {
                    setConfirmNoSubject(false);
                    sendDraft(toDraft());
                }}
            />
        </div>
    );
}
