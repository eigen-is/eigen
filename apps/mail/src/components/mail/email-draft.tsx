// The mail composer: recipients, subject, body and attachments of one draft, and the send. Its state
// and auto-save live in useDraft. Files come in from the disk, from Drive or from a forwarded message,
// and each is staged on the server before a save embeds it. A send that lacks a recipient or any content says so
// under the field. At send time it offers to share the Drive documents the mail links with recipients who cannot
// open them yet.

import { useHotkey } from '@tanstack/react-hotkeys';
import { rethrowUntoasted } from '@workspace/lib/api-error';
import { useAuth } from '@workspace/lib/auth';
import { MAX_SEND_REFERENCES } from '@workspace/lib/constants/mail';
import { checkPathAccess } from '@workspace/lib/drive';
import {
    canonicalRecipients,
    useAttachFromDrive,
    useAttachMailPart,
    useUploadDraftAttachment,
} from '@workspace/lib/mail';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_CHAT, isContainerType, stripEigenExtension } from '@workspace/lib/types/drive';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import type { DraftUpdateOptions, EmailDraft as EmailDraftType, NewDraft } from '@workspace/lib/types/mail';
import { Button } from '@workspace/ui/components/button';
import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import { ContactAutosuggest } from '@workspace/ui/components/contacts';
import { DrivePickerWithUpload } from '@workspace/ui/components/drive';
import { LightEditor } from '@workspace/ui/components/editor';
import { FieldError } from '@workspace/ui/components/field';
import { FileDropOverlay } from '@workspace/ui/components/file-drop-overlay';
import { Input } from '@workspace/ui/components/input';
import { Toolbar, TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { useDialogOpen } from '@workspace/ui/hooks/use-dialog-open';
import { useFileDropTarget } from '@workspace/ui/hooks/use-file-drop-target';
import { useFilePasteTarget } from '@workspace/ui/hooks/use-file-paste-target';
import { Paperclip, Send, Trash2 } from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { DraftAttachments } from './draft-attachments';
import { useDraft } from './hooks/use-draft';
import type { ShareGrant } from './share-and-send-dialog';
import { ShareAndSendDialog } from './share-and-send-dialog';

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
                <Button type="submit" form="draft-form" pending={isSending} size="sm">
                    <Send className="h-4 w-4" />
                    Send
                </Button>
                <TooltipButton icon={Paperclip} tooltipText="Attach file" onClick={onAttach} disabled={isSending} />
            </div>
            {hasId && <TooltipButton icon={Trash2} tooltipText="Delete" onClick={onDelete} disabled={isSending} />}
        </Toolbar>
    );
}

const RECIPIENT_FIELDS = [
    { field: 'to', label: 'To:' },
    { field: 'cc', label: 'Cc:' },
    { field: 'bcc', label: 'Bcc:' },
] as const;

const MISSING = { to: 'Add at least one recipient', subject: 'Add a subject or a message' } as const;

type EmailDraftProps = {
    email: EmailDraftType | null;
    // Quoted body / subject / recipients for reply/forward. useDraft reads it once on mount
    // and seeds its fingerprint from it, so no save fires until the user actually edits.
    prefillDraft?: NewDraft;
    // The parts of the message a forward carries. Each is fetched and uploaded once, while the forward
    // has no saved draft, and its chip is part of the prefill, so they alone save no draft.
    forwardedParts?: FileSubject[];
    to?: string;
    // Drive paths to attach when the composer opens, such as palette "Mail to…". They go through handleDriveAttach, once
    // per compose session.
    initialDriveAttachments?: DrivePath[];
    signatureHtml?: string;
    sendDraft: (mail: NewDraft, grantAccessRefIds?: string[]) => Promise<unknown>;
    onAutoSave: (mail: NewDraft, options?: DraftUpdateOptions) => Promise<EmailDraftType>;
    onDraftIdAssigned?: (id: string) => void;
    // A forward's parts stay in history state until a saved draft holds them all, so a reload before
    // then attaches them again.
    onForwardedPartsSaved?: () => void;
    isSending: boolean;
    // The draft flush and the access probe run before the send mutation starts; the route folds
    // that earlier window into the isSending it feeds back here and to the toolbar.
    onPreparingSendChange: (preparing: boolean) => void;
    // File picker state lives in the route (the toolbar's attach button sits outside this
    // component), so open/close is controlled via props.
    filePickerOpen: boolean;
    onFilePickerOpenChange: (open: boolean) => void;
};

export function EmailDraft({
    email,
    prefillDraft,
    forwardedParts,
    to,
    initialDriveAttachments,
    signatureHtml,
    sendDraft,
    onAutoSave,
    onDraftIdAssigned,
    onForwardedPartsSaved,
    isSending,
    onPreparingSendChange,
    filePickerOpen,
    onFilePickerOpenChange,
}: EmailDraftProps) {
    const formRef = useRef<HTMLFormElement>(null);
    // Once a send was refused, what it lacks shows under its field until the user adds it.
    const [sendRefused, setSendRefused] = useState(false);
    const [attachRefusal, setAttachRefusal] = useState<string>();
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
    const attachMailPartMutation = useAttachMailPart();

    const {
        state,
        setField,
        addAttachment,
        addPrefillAttachment,
        addDriveReference,
        removeAttachment,
        removeDriveReference,
        isSendable,
        flushAndGetDraft,
        disableSaves,
        enableSaves,
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
        // Uploads run in parallel so small attachments don't wait on each other. The mutation hook reports each
        // error, and one failed upload still lets the others finish.
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
        // Every Drive attach comes through here, so the reference cap holds here: past it the draft schema refuses
        // every save and the draft is lost.
        const fresh = paths.filter((p) => isContainerType(p.type) && !state.driveReferences.some((r) => r.id === p.id));
        const room = Math.max(0, MAX_SEND_REFERENCES - state.driveReferences.length);
        setAttachRefusal(
            fresh.length > room ? `You can link at most ${MAX_SEND_REFERENCES} documents to one mail` : undefined,
        );
        for (const path of fresh.slice(0, room)) {
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

    // Once per compose session, so a re-render of the route doesn't attach them twice: attachFromDriveMutation is not
    // idempotent.
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

    // Attached once on mount, in the original's order. A part that fails was toasted by the hook and is left out, and a
    // composer that opens on the saved draft finds them already in it.
    const didAttachForwardedPartsRef = useRef(false);
    const [forwardedPartsAttached, setForwardedPartsAttached] = useState(false);
    const attachForwardedParts = useEffectEvent(async (parts: FileSubject[]) => {
        const results = await Promise.all(
            parts.map((part) => attachMailPartMutation.mutateAsync(part).catch(() => null)),
        );
        for (const result of results) {
            if (!result) continue;
            addPrefillAttachment({
                key: `forward-${result.tempId}`,
                tempId: result.tempId,
                filename: result.filename,
                size: result.size,
                contentType: result.contentType,
            });
        }
        setForwardedPartsAttached(true);
    });
    useEffect(() => {
        if (email || didAttachForwardedPartsRef.current || !forwardedParts?.length) return;
        didAttachForwardedPartsRef.current = true;
        void attachForwardedParts(forwardedParts);
    }, [forwardedParts]);

    // A save embeds a chip's upload and drops its tempId. The first save can run while a part still
    // uploads, so the parts are saved only once the draft has an id and no forwarded chip waits.
    const forwardedPartsSaved =
        forwardedPartsAttached &&
        !!state.id &&
        !state.attachments.some((a) => a.key.startsWith('forward-') && a.tempId);
    const reportForwardedPartsSaved = useEffectEvent(() => onForwardedPartsSaved?.());
    useEffect(() => {
        if (forwardedPartsSaved) reportForwardedPartsSaved();
    }, [forwardedPartsSaved]);

    // Saves stop only at dispatch, which keeps the draft editable when the user backs out of "Share before sending?" or the
    // send is rejected.
    const dispatchSend = (mail: NewDraft, grantAccessRefIds?: string[]) => {
        disableSaves();
        return sendDraft(mail, grantAccessRefIds).catch((error) => {
            enableSaves();
            throw error;
        });
    };

    // Stops a rapid double-click in the two-network-hop gap between the send click and the dispatch,
    // where the mutation hasn't started yet: state alone would re-render too late to disable Send.
    const sendingRef = useRef(false);

    // When the draft links documents, offer the recipients who need it view access before sending.
    const sendWithFreshDraft = async () => {
        if (sendingRef.current) return;
        sendingRef.current = true;
        onPreparingSendChange(true);
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

            // A failed check (stale 404, network) leaves that reference out of the dialog, so the mail sends with whatever access
            // already exists.
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
                    notes.push(`You can't share ${stripEigenExtension(ref.name)}. Recipients can request access.`);
                    continue;
                }
                // The server grants only To and Cc, since a Bcc grant would show the Bcc to every reader. Any shareable reference with a
                // needing Bcc recipient is flagged, so the exclusion note shows once the dialog opens.
                const needingToCc = needing.filter((r) => !bcc.has(r.email));
                if (needing.length > needingToCc.length) hasShareableBcc = true;
                if (needingToCc.length === 0) continue;
                grants.push({
                    id: ref.id,
                    name: stripEigenExtension(ref.name),
                    mimeType: ref.mimeType,
                    driveType: ref.driveType,
                    recipients: needingToCc.map((r) => r.email),
                });
            }
            if (hasShareableBcc) notes.push('Bcc recipients are not granted access');

            if (grants.length === 0 && notes.length === 0) {
                await dispatchSend(draft);
                return;
            }
            // Notes alone still open it: a sender whose link lands on request-access should hear it
            // first. Dedupe collapses the repeated chat note when several chat references are linked.
            setShareState({ draft, grants, notes: [...new Set(notes)] });
        } finally {
            sendingRef.current = false;
            onPreparingSendChange(false);
        }
    };

    // Linked documents count as content, mirroring messageSend's ref-only allowance.
    const missing = !isSendable
        ? 'to'
        : !state.subject.trim() && !state.bodyText.trim() && state.driveReferences.length === 0
          ? 'subject'
          : null;
    const shownMissing = sendRefused ? missing : null;

    const handleSendEmail = async () => {
        if (missing) {
            setSendRefused(true);
            formRef.current?.querySelector<HTMLElement>(`#${missing}`)?.focus();
            return;
        }
        if (!state.subject.trim()) {
            setConfirmNoSubject(true);
            return;
        }
        // A rejected send was toasted by its hook and the draft stays open; the dialog entry points
        // need the rejection to stay open, so only this one swallows it.
        await sendWithFreshDraft().catch(rethrowUntoasted);
    };

    // A modifier combo fires even while an input or editor is focused, and the body editor's submitOnModEnter keeps HardBreak
    // from firing first. A dialog over the draft, such as Share & send or a form, owns its own Cmd+Enter.
    const dialogOpen = useDialogOpen();
    useHotkey('Mod+Enter', () => void handleSendEmail(), { enabled: !isSending && !dialogOpen });

    const { targetProps, isDragging } = useFileDropTarget(uploadFiles);
    const { onPaste } = useFilePasteTarget(uploadFiles);

    const fromDisplay = user ? `${user.name || user.email} <${user.email}>` : '';

    return (
        <div className="relative flex flex-col h-full w-full" {...targetProps} onPaste={onPaste}>
            <form
                ref={formRef}
                id="draft-form"
                className="flex flex-col flex-1 min-h-0"
                onSubmit={(e) => {
                    e.preventDefault();
                    handleSendEmail();
                }}
                // Enter would submit the form, which sends, with any modifier, and on a Mac Ctrl+Enter is not the send hotkey. Mod+Enter
                // still sends, as the hotkey ignores defaultPrevented.
                onKeyDown={(e) => {
                    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                    if (!(e.target instanceof HTMLInputElement)) return;
                    e.preventDefault();
                    if (e.target.id === 'subject') focusBodyEditor(e.currentTarget);
                }}
            >
                <div className="space-y-1 app-gutter-x py-2 shrink-0">
                    {RECIPIENT_FIELDS.map(({ field, label }) => (
                        <div key={field} className="grid grid-cols-[4rem_1fr] items-center border-b">
                            <label htmlFor={field} className="text-sm text-muted-foreground">
                                {label}
                            </label>
                            <ContactAutosuggest
                                initialValue={state[field]}
                                onChange={(val) => setField(field, val)}
                                appendMode
                                inputClassName="bg-transparent border-none focus-visible:ring-0 py-2 px-0 h-auto"
                                disabled={isSending}
                                autoComplete="off"
                                id={field}
                                aria-invalid={shownMissing === field || undefined}
                                aria-describedby={shownMissing === field ? `${field}-error` : undefined}
                            />
                            {shownMissing === field && <MissingError field={field} />}
                        </div>
                    ))}
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
                            aria-invalid={shownMissing === 'subject' || undefined}
                            aria-describedby={shownMissing === 'subject' ? 'subject-error' : undefined}
                        />
                        {shownMissing === 'subject' && <MissingError field="subject" />}
                    </div>
                </div>
                <DraftAttachments
                    attachments={state.attachments}
                    driveReferences={state.driveReferences}
                    onRemove={removeAttachment}
                    onRemoveReference={removeDriveReference}
                />
                {attachRefusal && <FieldError className="app-gutter-x pb-2">{attachRefusal}</FieldError>}
                <div
                    className="flex-1 overflow-auto app-gutter cursor-text"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) focusBodyEditor(e.currentTarget);
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
            <FileDropOverlay visible={isDragging} label="Drop files to attach" icon={Paperclip} />
            <ConfirmDialog
                open={confirmNoSubject}
                onOpenChange={setConfirmNoSubject}
                title="Send without subject?"
                description="This message has no subject. Send anyway?"
                confirmText="Send"
                onConfirm={sendWithFreshDraft}
            />
            {shareState && (
                // Conditionally mounted so the copy can't flash to empty during an exit animation.
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

// Recipients as the server will see them at send, minus the sender, so this preview's grant set matches what it grants.
// `bcc` holds the lowercased addresses that resolved as Bcc-only, which the server never grants.
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

function MissingError({ field }: { field: keyof typeof MISSING }) {
    return (
        <FieldError id={`${field}-error`} className="col-start-2 pb-1.5">
            {MISSING[field]}
        </FieldError>
    );
}

function focusBodyEditor(root: HTMLElement) {
    root.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
}
