import { useAuth } from '@workspace/lib/auth';
import { useUploadDraftAttachment } from '@workspace/lib/mail';
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
import { cn } from '@workspace/ui/lib/utils';
import { Paperclip, Send, Trash2 } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { DraftAttachments } from './draft-attachments';
import { useDraftAutoSave } from './hooks/use-draft-auto-save';
import { useDraftState } from './hooks/use-draft-state';

export type EmailDraftHandle = {
    openFilePicker: () => void;
};

export function EmailDraftToolbar({
    onDelete,
    onAttach,
    isSending,
    hasId,
}: {
    onDelete: () => void;
    onAttach?: () => void;
    isSending: boolean;
    hasId: boolean;
}) {
    return (
        <Toolbar>
            <div className="flex items-center gap-1">
                <TooltipButton icon={Send} tooltipText="Send" type="submit" form="draft-form" disabled={isSending} />
                {onAttach && (
                    <TooltipButton icon={Paperclip} tooltipText="Attach file" onClick={onAttach} disabled={isSending} />
                )}
            </div>
            {hasId && <TooltipButton icon={Trash2} tooltipText="Delete" onClick={onDelete} disabled={isSending} />}
        </Toolbar>
    );
}

type EmailDraftProps = {
    email: EmailDraftType | null;
    to?: string;
    sendDraft: (mail: NewDraft) => Promise<unknown>;
    onAutoSave?: (
        mail: NewDraft,
        options?: { tempAttachmentIds?: string[]; keepAttachmentIndexes?: number[] },
    ) => Promise<EmailDraftType | null | undefined>;
    onDraftIdAssigned?: (id: string) => void;
    isSending: boolean;
};

export const EmailDraft = forwardRef<EmailDraftHandle, EmailDraftProps>(function EmailDraft(
    { email, to, sendDraft, onAutoSave, onDraftIdAssigned, isSending },
    ref,
) {
    const [alertMessage, setAlertMessage] = useState<string | null>(null);
    const [confirmNoSubject, setConfirmNoSubject] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const { user } = useAuth();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragCounterRef = useRef(0);
    const uploadMutation = useUploadDraftAttachment();

    const {
        state,
        setField,
        setId,
        addAttachment,
        removeAttachment,
        setAttachmentsFromServer,
        toDraft,
        attachmentsFingerprint,
        isSendable,
        isSaveable,
    } = useDraftState(email, to);

    const {
        scheduleSave,
        saveNow,
        disable: disableAutoSave,
    } = useDraftAutoSave({
        toDraft,
        attachmentsFingerprint,
        isSaveable,
        draftId: state.id,
        onSave: onAutoSave
            ? async (draft) => {
                  const tempAttachmentIds = state.attachments.map((a) => a.tempId).filter((id): id is string => !!id);
                  const keepAttachmentIndexes = state.attachments
                      .map((a) => a.index)
                      .filter((i): i is number => typeof i === 'number');
                  const result = await onAutoSave(draft, {
                      tempAttachmentIds: tempAttachmentIds.length ? tempAttachmentIds : undefined,
                      // Always send the keep list when the draft has an id — an empty array means
                      // "user removed all original attachments", which we must respect.
                      keepAttachmentIndexes: state.id ? keepAttachmentIndexes : undefined,
                  });
                  if (result) setAttachmentsFromServer(result.attachments ?? []);
                  return result;
              }
            : undefined,
        onIdAssigned: (id) => {
            setId(id);
            onDraftIdAssigned?.(id);
        },
    });

    const uploadFiles = async (files: FileList | File[] | null) => {
        if (!files) return;
        const list = files instanceof FileList ? Array.from(files) : files;
        // Uploads run in parallel — multiple small attachments shouldn't block on each other.
        // Errors toast via the mutation hook; any individual failure still lets the others proceed.
        const results = await Promise.all(
            list.map(async (file) => {
                const result = await uploadMutation.mutateAsync(file).catch(() => null);
                return result ? { file, result } : null;
            }),
        );
        for (const entry of results) {
            if (!entry) continue;
            const { file, result } = entry;
            const localUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
            addAttachment({
                key: `upload-${result.tempId}`,
                tempId: result.tempId,
                filename: result.filename,
                size: result.size,
                contentType: result.contentType,
                localUrl,
            });
        }
        scheduleSave();
    };

    useImperativeHandle(ref, () => ({
        openFilePicker: () => fileInputRef.current?.click(),
    }));

    useEffect(() => {
        scheduleSave();
    }, [state.to, state.cc, state.bcc, state.subject, state.body, scheduleSave]);

    const sendWithFreshDraft = useCallback(async () => {
        // Flush pending save first. setId inside useDraftState updates its stateRef synchronously,
        // so toDraft() after saveNow() includes the server-assigned id and the send path sees
        // isNew=false and re-extracts attachments from the EML on disk.
        await saveNow();
        disableAutoSave();
        await sendDraft(toDraft());
    }, [saveNow, disableAutoSave, toDraft, sendDraft]);

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
        await sendWithFreshDraft();
    };

    const handleDragEnter = (e: React.DragEvent) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        dragCounterRef.current += 1;
        setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        dragCounterRef.current -= 1;
        if (dragCounterRef.current <= 0) {
            dragCounterRef.current = 0;
            setIsDragging(false);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        dragCounterRef.current = 0;
        setIsDragging(false);
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) void uploadFiles(files);
    };

    const fromDisplay = user ? `${user.name || user.email} <${user.email}>` : '';

    return (
        <div
            className="relative flex flex-col h-full w-full"
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
        >
            <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                    void uploadFiles(e.target.files);
                    e.target.value = '';
                }}
                disabled={isSending}
            />
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
                                value={fromDisplay}
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
                    <DraftAttachments
                        attachments={state.attachments}
                        onRemove={(i) => {
                            removeAttachment(i);
                            scheduleSave();
                        }}
                    />
                    <div
                        className="flex-1 p-4 cursor-text"
                        onClick={(e) => {
                            if (e.target === e.currentTarget) {
                                const editable = e.currentTarget.querySelector<HTMLElement>('[contenteditable="true"]');
                                editable?.focus();
                            }
                        }}
                    >
                        <LightEditor
                            content={state.body}
                            onChange={(html) => setField('body', html)}
                            placeholder="Write your message here..."
                            toolbar="floating"
                            className="w-full h-full"
                            editable={!isSending}
                        />
                    </div>
                </form>
            </div>
            <div
                className={cn(
                    'pointer-events-none absolute inset-0 rounded-lg border-2 border-dashed border-primary bg-primary/5 flex items-center justify-center transition-opacity',
                    isDragging ? 'opacity-100' : 'opacity-0',
                )}
            >
                <div className="flex items-center gap-2 text-primary text-sm font-medium">
                    <Paperclip className="h-4 w-4" />
                    Drop files to attach
                </div>
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
                onConfirm={async () => {
                    setConfirmNoSubject(false);
                    await sendWithFreshDraft();
                }}
            />
        </div>
    );
});
