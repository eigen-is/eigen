import { useHotkey } from '@tanstack/react-hotkeys';
import { useAuth } from '@workspace/lib/auth';
import { checkPathAccess } from '@workspace/lib/drive';
import { useAttachFromDrive, useUploadDraftAttachment } from '@workspace/lib/mail';
import { canonicalRecipients } from '@workspace/lib/mail/addresses';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_CHAT, isContainerType } from '@workspace/lib/types/drive';
import type { EmailDraft as EmailDraftType, NewDraft } from '@workspace/lib/types/mail';
import { ConfirmDialog, Toolbar, TooltipButton } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { ContactAutosuggest } from '@workspace/ui/components/contacts';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@workspace/ui/components/dialog';
import { DrivePickerWithUpload } from '@workspace/ui/components/drive';
import { LightEditor } from '@workspace/ui/components/editor';
import { Input } from '@workspace/ui/components/input';
import { useFileDropTarget } from '@workspace/ui/hooks/use-file-drop-target';
import { useFilePasteTarget } from '@workspace/ui/hooks/use-file-paste-target';
import { cn } from '@workspace/ui/lib/utils';
import { Paperclip, Send, Trash2 } from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { DraftAttachments } from './draft-attachments';
import { useDraft } from './hooks/use-draft';
import { ShareAndSendDialog, type ShareGrant } from './share-and-send-dialog';

// Recipients as the backend will see them at send, minus the sender: the shared canonicaliser
// flattens RFC 2822 groups and dedupes case-insensitively with to > cc > bcc precedence (an address
// in both To and Bcc classifies as To), so this preview's grant set matches what the server grants.
// `bcc` holds the lowercased addresses that resolved as Bcc-only — the set the backend never grants.
function collectRecipientEmails(draft: NewDraft, ownEmail: string | undefined): { all: string[]; bcc: Set<string> } {
    const own = ownEmail?.toLowerCase();
    const all: string[] = [];
    const bcc = new Set<string>();
    for (const { address, field } of canonicalRecipients(draft)) {
        const key = address.toLowerCase();
        if (key === own) continue;
        all.push(address);
        if (field === 'bcc') bcc.add(key);
    }
    return { all, bcc };
}

export function EmailDraftToolbar({
    onDelete,
    onAttach,
    isSending,
    hasId,
}: {
    onDelete: () => void;
    onAttach: () => void;
    isSending: boolean;
    hasId: boolean;
}) {
    return (
        <Toolbar>
            <div className="flex items-center gap-1">
                <Button type="submit" form="draft-form" disabled={isSending} size="sm">
                    <Send className="h-4 w-4" />
                    Send
                </Button>
                <TooltipButton icon={Paperclip} tooltipText="Attach file" onClick={onAttach} disabled={isSending} />
            </div>
            {hasId && <TooltipButton icon={Trash2} tooltipText="Delete" onClick={onDelete} disabled={isSending} />}
        </Toolbar>
    );
}

type EmailDraftProps = {
    email: EmailDraftType | null;
    // Quoted body / subject / recipients for reply/forward. useDraft reads it once on mount
    // and seeds its fingerprint from it, so no save fires until the user actually edits.
    prefillDraft?: NewDraft;
    to?: string;
    // Drive paths to attach when the composer opens (e.g. palette "Mail to…" passes the
    // selection through the URL). Routed through the same handleDriveAttach the in-app
    // picker uses, so containers become driveReferences and plain files are copied via
    // useAttachFromDrive. Fired once per compose session.
    initialDriveAttachments?: DrivePath[];
    signatureHtml?: string;
    sendDraft: (mail: NewDraft, grantAccessRefIds?: string[]) => Promise<unknown>;
    onAutoSave?: (
        mail: NewDraft,
        options?: { tempAttachmentIds?: string[]; keepAttachmentIndexes?: number[]; forceFullSave?: boolean },
    ) => Promise<EmailDraftType | null | undefined>;
    onDraftIdAssigned?: (id: string) => void;
    isSending: boolean;
    // File picker state lives in the route (the toolbar's attach button sits outside this
    // component), so open/close is controlled via props.
    filePickerOpen: boolean;
    onFilePickerOpenChange: (open: boolean) => void;
};

export function EmailDraft({
    email,
    prefillDraft,
    to,
    initialDriveAttachments,
    signatureHtml,
    sendDraft,
    onAutoSave,
    onDraftIdAssigned,
    isSending,
    filePickerOpen,
    onFilePickerOpenChange,
}: EmailDraftProps) {
    const [alertMessage, setAlertMessage] = useState<string | null>(null);
    const [confirmNoSubject, setConfirmNoSubject] = useState(false);
    // Set once the time-of-send access check finds a grantable reference: holds the flushed draft to
    // send plus the aggregated dialog contents. Null closes the Share & send dialog.
    const [shareState, setShareState] = useState<{
        draft: NewDraft;
        grants: ShareGrant[];
        notes: string[];
    } | null>(null);
    const { user } = useAuth();
    const uploadMutation = useUploadDraftAttachment();
    const attachFromDriveMutation = useAttachFromDrive();

    const {
        state,
        setField,
        addAttachment,
        addDriveReference,
        removeAttachment,
        removeDriveReference,
        isSendable,
        flushAndGetDraft,
        disableSaves,
        markEditorReady,
    } = useDraft({
        email,
        prefillTo: to,
        prefillDraft,
        signatureHtml,
        onSave: onAutoSave,
        onDraftIdAssigned,
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
    };

    const handleDriveAttach = async (paths: DrivePath[]) => {
        for (const path of paths) {
            if (isContainerType(path.type)) {
                addDriveReference({
                    type: 'reference',
                    ownerId: path.ownerId,
                    mountId: path.mountId,
                    id: path.id,
                    name: path.name,
                    driveType: path.type,
                    mimeType: path.mimeType,
                });
            }
        }
        const files = paths.filter((p) => !isContainerType(p.type));
        const results = await Promise.all(
            files.map((path) =>
                attachFromDriveMutation
                    .mutateAsync({
                        sourceOwnerId: path.ownerId,
                        sourceMountId: path.mountId,
                        sourcePathId: path.id,
                    })
                    .catch(() => null),
            ),
        );
        for (const result of results) {
            if (!result) continue;
            addAttachment({
                key: `drive-${result.tempId}`,
                tempId: result.tempId,
                filename: result.filename,
                size: result.size,
                contentType: result.contentType,
            });
        }
    };

    // Cross-app drive attachments (palette "Mail to…") arrive as DrivePath[] from the route
    // once the URL refs resolve. Hand them to handleDriveAttach — same path the toolbar's
    // Paperclip button uses — once per compose session, so a re-render of the route doesn't
    // attach them twice (attachFromDriveMutation is not idempotent).
    const didApplyInitialAttachmentsRef = useRef(false);
    // handleDriveAttach is recreated each render (over useDraft's stable dispatch); read the
    // latest via an Effect Event so the effect stays reactive to initialDriveAttachments only.
    const applyInitialAttachments = useEffectEvent((paths: DrivePath[]) => {
        void handleDriveAttach(paths);
    });
    useEffect(() => {
        if (didApplyInitialAttachmentsRef.current) return;
        if (!initialDriveAttachments || initialDriveAttachments.length === 0) return;
        didApplyInitialAttachmentsRef.current = true;
        applyInitialAttachments(initialDriveAttachments);
    }, [initialDriveAttachments]);

    // Every actual send funnels through here: stop auto-saving (we're leaving this draft behind) then
    // dispatch. Deferring disableSaves() to dispatch time is what keeps the draft editable when the
    // user backs out of the "Share before sending?" dialog.
    const dispatchSend = (mail: NewDraft, grantAccessRefIds?: string[]) => {
        disableSaves();
        return sendDraft(mail, grantAccessRefIds);
    };

    // Guards the two-network-hop gap between the send click and the dispatch, where the Send button
    // isn't disabled yet (isSending flips only once the mutation runs) — a rapid double-click would
    // otherwise start two sends. Reset in `finally`, including the dialog-open path.
    const sendingRef = useRef(false);

    // Both send entry points funnel here (the Send button via handleSendEmail, and the no-subject
    // ConfirmDialog). When the draft links documents, offer recipients who need it view access before
    // sending; otherwise send exactly as today.
    const sendWithFreshDraft = async () => {
        if (sendingRef.current) return;
        sendingRef.current = true;
        try {
            const draft = await flushAndGetDraft();
            const refs = draft.driveReferences ?? [];
            if (refs.length === 0) {
                await dispatchSend(draft);
                return;
            }
            const { all: emails, bcc } = collectRecipientEmails(draft, user?.email);
            if (emails.length === 0) {
                await dispatchSend(draft);
                return;
            }

            // Probe each reference for the current recipient set. A failed check (stale 404, network)
            // makes that reference non-checkable — excluded from the dialog entirely, so the mail
            // sends as-is with whatever access already exists (the link may be dead, exactly as today).
            const checks = await Promise.all(
                refs.map((ref) =>
                    checkPathAccess(ref.ownerId, ref.mountId, ref.id, emails)
                        .then((result) => ({ ref, result }))
                        .catch(() => null),
                ),
            );

            const grants: ShareGrant[] = [];
            const notes: string[] = [];
            let hasShareableBcc = false;
            for (const check of checks) {
                if (!check) continue;
                const { ref, result } = check;
                const needing = result.recipients.filter((r) => !r.hasReadAccess || r.needsGuestAdmission);
                if (needing.length === 0) continue;
                if (ref.driveType === DRIVE_TYPE_CHAT) {
                    notes.push("Chat invitations aren't granted from mail");
                    continue;
                }
                if (!result.canShare) {
                    notes.push(`You can't share ${ref.name}. Recipients can request access.`);
                    continue;
                }
                // The backend only grants To/Cc recipients; a Bcc grant would leak the Bcc identity to
                // every reader. Flag any shareable ref with a needing Bcc recipient — even one whose
                // needing recipients are all Bcc — so the exclusion note shows once the dialog opens.
                const needingToCc = needing.filter((r) => !bcc.has(r.email));
                if (needing.length > needingToCc.length) hasShareableBcc = true;
                if (needingToCc.length === 0) continue;
                grants.push({ id: ref.id, name: ref.name, recipients: needingToCc.map((r) => r.email) });
            }
            if (hasShareableBcc) notes.push('Bcc recipients are not granted access');

            if (grants.length === 0) {
                await dispatchSend(draft);
                return;
            }
            // Dedupe collapses the repeated chat note when several chat references are linked.
            setShareState({ draft, grants, notes: [...new Set(notes)] });
        } finally {
            sendingRef.current = false;
        }
    };

    const handleSendEmail = async () => {
        if (!isSendable) {
            setAlertMessage('Please specify at least one recipient.');
            return;
        }
        if (!state.subject.trim() && !state.bodyText.trim()) {
            setAlertMessage('Please add a subject or message.');
            return;
        }
        if (!state.subject.trim()) {
            setConfirmNoSubject(true);
            return;
        }
        await sendWithFreshDraft();
    };

    // ⌘/Ctrl+Enter sends from subject, recipients, or body. Mod+Enter is a modifier
    // combo so the app-wide hotkey listener fires it even while an input/editor is
    // focused; the body editor's submitOnModEnter keeps HardBreak from firing first.
    useHotkey('Mod+Enter', () => void handleSendEmail(), { enabled: !isSending });

    const { targetProps, isDragging } = useFileDropTarget(uploadFiles);
    const { onPaste } = useFilePasteTarget(uploadFiles);

    const fromDisplay = user ? `${user.name || user.email} <${user.email}>` : '';

    return (
        <div className="relative flex flex-col h-full w-full" {...targetProps} onPaste={onPaste}>
            <form
                id="draft-form"
                className="flex flex-col flex-1 min-h-0"
                onSubmit={(e) => {
                    e.preventDefault();
                    handleSendEmail();
                }}
            >
                <div className="space-y-1 app-gutter-x py-2 shrink-0">
                    <div className="grid grid-cols-[4rem_1fr] items-center border-b">
                        <label htmlFor="to" className="text-sm text-muted-foreground">
                            To:
                        </label>
                        <ContactAutosuggest
                            initialValue={state.to}
                            onChange={(val) => setField('to', val)}
                            appendMode
                            inputClassName="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                            disabled={isSending}
                            autoComplete="off"
                            id="to"
                        />
                    </div>
                    <div className="grid grid-cols-[4rem_1fr] items-center border-b">
                        <label htmlFor="cc" className="text-sm text-muted-foreground">
                            Cc:
                        </label>
                        <ContactAutosuggest
                            initialValue={state.cc}
                            onChange={(val) => setField('cc', val)}
                            appendMode
                            inputClassName="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                            disabled={isSending}
                            autoComplete="off"
                            id="cc"
                        />
                    </div>
                    <div className="grid grid-cols-[4rem_1fr] items-center border-b">
                        <label htmlFor="bcc" className="text-sm text-muted-foreground">
                            Bcc:
                        </label>
                        <ContactAutosuggest
                            initialValue={state.bcc}
                            onChange={(val) => setField('bcc', val)}
                            appendMode
                            inputClassName="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                            disabled={isSending}
                            autoComplete="off"
                            id="bcc"
                        />
                    </div>
                    <div className="grid grid-cols-[4rem_1fr] items-center border-b">
                        <label htmlFor="from" className="text-sm text-muted-foreground">
                            From:
                        </label>
                        <Input
                            id="from"
                            value={fromDisplay}
                            disabled
                            className="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                        />
                    </div>
                    <div className="grid grid-cols-[4rem_1fr] items-center border-b">
                        <label htmlFor="subject" className="text-sm text-muted-foreground">
                            Subject:
                        </label>
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
                    driveReferences={state.driveReferences}
                    onRemove={removeAttachment}
                    onRemoveReference={removeDriveReference}
                />
                <div
                    className="flex-1 overflow-auto app-gutter cursor-text"
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
                        onChangeText={(text) => setField('bodyText', text)}
                        onReady={({ html, text }) => markEditorReady(html, text)}
                        placeholder="Write your message here..."
                        toolbar="floating"
                        className="w-full h-full"
                        editable={!isSending}
                        submitOnModEnter
                    />
                </div>
            </form>
            <DrivePickerWithUpload
                open={filePickerOpen}
                onOpenChange={onFilePickerOpenChange}
                title="Attach file"
                multiSelect
                onPickFromDrive={handleDriveAttach}
                onPickFromDevice={(files) => void uploadFiles(files)}
                multiple
            />
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
                onConfirm={sendWithFreshDraft}
            />
            {shareState && (
                // Conditionally mounted so the copy can't flash to empty during an exit animation —
                // the whole dialog leaves the tree the instant it closes (drive-access-dialog idiom).
                <ShareAndSendDialog
                    open
                    onOpenChange={(open) => {
                        if (!open) setShareState(null);
                    }}
                    grants={shareState.grants}
                    notes={shareState.notes}
                    onShareAndSend={async () => {
                        await dispatchSend(
                            shareState.draft,
                            shareState.grants.map((g) => g.id),
                        );
                    }}
                    onSendWithoutAccess={async () => {
                        await dispatchSend(shareState.draft);
                    }}
                />
            )}
        </div>
    );
}
