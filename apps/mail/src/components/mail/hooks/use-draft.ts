// The composer's state for one draft and its auto-save. A save fires a short while after the fields
// drift from what the server has, and once more when the composer closes. The prefill of a reply or
// forward counts as saved, so a draft only reaches Drafts once the user changes something.

import { AppError, rethrowUntoasted } from '@workspace/lib/api-error';
import type { AuthUser } from '@workspace/lib/auth';
import { useAuth } from '@workspace/lib/auth';
import { flattenAddresses } from '@workspace/lib/mail';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import type {
    AddressObject,
    Attachment,
    AttachmentMeta,
    DraftUpdateOptions,
    EmailDraft,
    NewDraft,
} from '@workspace/lib/types/mail';
import { mailAttachmentName } from '@workspace/lib/types/mail';
import { useEffect, useReducer, useRef } from 'react';

const AUTO_SAVE_DEBOUNCE_MS = 2500;

type DraftFields = {
    id?: string;
    to: string;
    cc: string;
    bcc: string;
    subject: string;
    body: string;
    bodyText: string;
    attachments: AttachmentMeta[];
    driveReferences: AttachmentReference[];
    inReplyTo?: string;
    references?: string[] | string;
    repliedToId?: string;
    messageId?: string;
};

type DraftEditableField = 'to' | 'cc' | 'bcc' | 'subject' | 'body' | 'bodyText';

type DraftState = {
    fields: DraftFields;
    // Fingerprint of the fields the server actually has. Drift from this triggers an auto-save.
    lastSavedFingerprint: string;
};

type Action =
    | { type: 'set-field'; field: DraftEditableField; value: string }
    | { type: 'set-id'; id: string }
    | { type: 'add-attachment'; meta: AttachmentMeta }
    | { type: 'add-prefill-attachment'; meta: AttachmentMeta }
    | { type: 'remove-attachment'; index: number }
    | { type: 'add-drive-ref'; ref: AttachmentReference }
    | { type: 'remove-drive-ref'; id: string }
    | { type: 'sync-editor'; html: string; text: string }
    | { type: 'save-completed'; sentFields: DraftFields; serverAttachments: Attachment[] };

type UseDraftOptions = {
    email: EmailDraft | null;
    prefillTo?: string;
    // A reply's or forward's quoted body, subject and recipients. They count as saved, so no save fires until an edit.
    prefillDraft?: NewDraft;
    signatureHtml?: string;
    onSave: (draft: NewDraft, options?: DraftUpdateOptions) => Promise<EmailDraft>;
    onDraftIdAssigned?: (id: string) => void;
};

function addressObjectToString(addr?: AddressObject): string {
    if (!addr) return '';
    if (addr.text) return addr.text;
    // Reply-all builds AddressObjects with only `value` set. Flattened so an RFC 2822 group can never render as `Team <>`.
    return flattenAddresses(addr.value)
        .map(({ name, address }) => (name ? `${name} <${address}>` : address))
        .join(', ');
}

function stringToAddressObject(text: string): AddressObject | undefined {
    if (!text.trim()) return undefined;
    const value = text.split(',').map((part) => {
        const trimmed = part.trim();
        const match = trimmed.match(/^(.*?)\s*<(.+?)>$/);
        if (match) return { name: match[1].trim(), address: match[2].trim() };
        return { name: '', address: trimmed };
    });
    return { value, text };
}

// TipTap's own form of an empty paragraph, so its first normalization doesn't read as an edit and trip the auto-save.
const EMPTY_PARA = '<p><br></p>';

function injectSignature(body: string, sig: string | undefined, kind: 'new' | 'reply'): string {
    if (!sig) return body;
    if (kind === 'new') return body + EMPTY_PARA + sig;
    // TipTap rewrites bare <br>s between blocks on first edit, so the quote's leading ones become one empty paragraph.
    const trimmed = body.replace(/^(<br\s*\/?>)+/i, '');
    return EMPTY_PARA + sig + EMPTY_PARA + trimmed;
}

// Mirrors TipTap getText() over the blocks LightEditor exposes (p, blockquote, ul/ol/li), so the seeded bodyText stays
// close to what the editor emits and the fingerprint holds on first interaction.
function plainSignature(sig: string | undefined): string {
    if (!sig) return '';
    return sig
        .replace(/<\/(p|li|blockquote|ul|ol)>\s*/gi, '\n\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function initFields(
    email: EmailDraft | null,
    prefillTo?: string,
    prefillDraft?: NewDraft,
    signatureHtml?: string,
): DraftFields {
    if (email) {
        // Saved-draft branch: never re-inject. The body is whatever the user last saved.
        return {
            id: email.id,
            to: addressObjectToString(email.to),
            cc: addressObjectToString(email.cc),
            bcc: addressObjectToString(email.bcc),
            subject: email.subject,
            body: email.html || email.text || '',
            bodyText: email.text || '',
            attachments: email.attachments.map((a) => ({
                key: `saved-${a.index}-${a.filename ?? ''}-${a.size}`,
                filename: mailAttachmentName(a, a.index),
                size: a.size,
                contentType: a.contentType,
            })),
            driveReferences: email.driveReferences ?? [],
            inReplyTo: email.inReplyTo,
            references: email.references,
            repliedToId: email.repliedToId,
            messageId: email.messageId,
        };
    }
    const sigText = plainSignature(signatureHtml);
    if (prefillDraft) {
        return {
            to: addressObjectToString(prefillDraft.to),
            cc: addressObjectToString(prefillDraft.cc),
            bcc: addressObjectToString(prefillDraft.bcc),
            subject: prefillDraft.subject || '',
            body: injectSignature(prefillDraft.html || '', signatureHtml, 'reply'),
            bodyText: sigText ? `${sigText}\n\n${prefillDraft.text || ''}` : prefillDraft.text || '',
            attachments: [],
            driveReferences: prefillDraft.driveReferences ?? [],
            inReplyTo: prefillDraft.inReplyTo,
            references: prefillDraft.references,
            repliedToId: prefillDraft.repliedToId,
            messageId: prefillDraft.messageId,
        };
    }
    return {
        to: prefillTo || '',
        cc: '',
        bcc: '',
        subject: '',
        body: injectSignature('', signatureHtml, 'new'),
        bodyText: sigText ? `\n\n${sigText}` : '',
        attachments: [],
        driveReferences: [],
    };
}

// A state whose fields the server has, or that the prefill seeded: nothing in it is an edit yet.
function savedState(fields: DraftFields): DraftState {
    return { fields, lastSavedFingerprint: fingerprintFields(fields) };
}

function isDirty(state: DraftState): boolean {
    return fingerprintFields(state.fields) !== state.lastSavedFingerprint;
}

function fingerprintFields(f: DraftFields): string {
    const attachments = f.attachments.map((a) => `${a.key}:${a.tempId ?? ''}`).join('|');
    const refs = f.driveReferences.map((r) => r.id).join(',');
    return JSON.stringify({
        to: f.to,
        cc: f.cc,
        bcc: f.bcc,
        subject: f.subject,
        body: f.body,
        bodyText: f.bodyText,
        attachments: `${attachments}#${refs}`,
    });
}

function fieldsToDraft(f: DraftFields, user: AuthUser | null | undefined): NewDraft {
    return {
        id: f.id,
        from: {
            value: [{ name: user?.name || '', address: user?.email || '' }],
            text: '',
        },
        to: stringToAddressObject(f.to),
        cc: stringToAddressObject(f.cc),
        bcc: stringToAddressObject(f.bcc),
        subject: f.subject,
        text: f.bodyText,
        html: f.body,
        inReplyTo: f.inReplyTo,
        references: f.references,
        repliedToId: f.repliedToId,
        messageId: f.messageId,
        driveReferences: f.driveReferences,
    };
}

function buildSaveOptions(fields: DraftFields): DraftUpdateOptions {
    const tempIds = fields.attachments.map((a) => a.tempId).filter((id): id is string => !!id);
    const kept = fields.attachments.filter((a) => !a.tempId).map(({ filename, size }) => ({ filename, size }));
    return {
        tempAttachmentIds: tempIds.length ? tempIds : undefined,
        // An empty list is the user removing every part, so a draft with an id always sends one.
        keepAttachments: fields.id ? kept : undefined,
    };
}

// Edits made while the save was in flight: `serverActual` is what the server has now, with local keys kept so chips don't
// remount, and `localNext` is the user's intent. Drift between the two re-triggers the auto-save.
function mergeServerAttachments(
    local: AttachmentMeta[],
    sent: AttachmentMeta[],
    parsed: Attachment[],
): { serverActual: AttachmentMeta[]; localNext: AttachmentMeta[] } {
    const serverActual = parsed.map((a) => {
        const filename = mailAttachmentName(a, a.index);
        const prevMatch = local.find((p) => p.filename === filename && p.size === a.size);
        return {
            key: prevMatch?.key ?? `server-${a.index}-${filename}-${a.size}`,
            filename,
            size: a.size,
            contentType: a.contentType,
            localUrl: prevMatch?.localUrl,
        };
    });

    const removedDuringSave = sent.filter((s) => !local.some((l) => l.filename === s.filename && l.size === s.size));
    const withoutRemoved = serverActual.filter(
        (a) => !removedDuringSave.some((r) => r.filename === a.filename && r.size === a.size),
    );
    // A chip still holding a tempId the save embedded would 404 on every later save, so an addition
    // is only in flight while no part of the server's answer carries its name and size.
    const inFlightAdditions = local.filter(
        (l) => !!l.tempId && !parsed.some((a) => mailAttachmentName(a, a.index) === l.filename && a.size === l.size),
    );

    return { serverActual, localNext: [...withoutRemoved, ...inFlightAdditions] };
}

function draftReducer(state: DraftState, action: Action): DraftState {
    switch (action.type) {
        case 'set-field':
            return { ...state, fields: { ...state.fields, [action.field]: action.value } };
        case 'set-id':
            return { ...state, fields: { ...state.fields, id: action.id } };
        case 'add-attachment':
            return {
                ...state,
                fields: { ...state.fields, attachments: [...state.fields.attachments, action.meta] },
            };
        case 'add-prefill-attachment': {
            // A forwarded part is prefill, like the quoted body, so a forward the user leaves saves no draft.
            // Once the user edited or a save gave the draft an id, it is an edit the next save must embed.
            const fields = { ...state.fields, attachments: [...state.fields.attachments, action.meta] };
            return !state.fields.id && !isDirty(state) ? savedState(fields) : { ...state, fields };
        }
        case 'remove-attachment':
            return {
                ...state,
                fields: {
                    ...state.fields,
                    attachments: state.fields.attachments.filter((_, i) => i !== action.index),
                },
            };
        case 'add-drive-ref':
            if (state.fields.driveReferences.some((r) => r.id === action.ref.id)) return state;
            return {
                ...state,
                fields: {
                    ...state.fields,
                    driveReferences: [...state.fields.driveReferences, action.ref],
                },
            };
        case 'remove-drive-ref':
            return {
                ...state,
                fields: {
                    ...state.fields,
                    driveReferences: state.fields.driveReferences.filter((r) => r.id !== action.id),
                },
            };
        case 'sync-editor': {
            // TipTap's normalization of the seeded body would otherwise drift from the seed on first interaction and fire the
            // auto-save without any user edit.
            return savedState({ ...state.fields, body: action.html, bodyText: action.text });
        }
        case 'save-completed': {
            const { serverActual, localNext } = mergeServerAttachments(
                state.fields.attachments,
                action.sentFields.attachments,
                action.serverAttachments,
            );
            // What the server has: the fields we sent and its post-parse attachment list. An edit made during the save diffs against
            // this and saves again.
            const serverHas = { ...action.sentFields, attachments: serverActual };
            return {
                ...state,
                fields: { ...state.fields, attachments: localNext },
                lastSavedFingerprint: fingerprintFields(serverHas),
            };
        }
    }
}

function isSaveable(f: DraftFields): boolean {
    return !!(f.to.trim() || f.subject.trim() || f.cc.trim() || f.bcc.trim() || f.bodyText.trim());
}

export function useDraft({
    email,
    prefillTo,
    prefillDraft,
    signatureHtml,
    onSave,
    onDraftIdAssigned,
}: UseDraftOptions) {
    const { user } = useAuth();
    const [state, dispatch] = useReducer(draftReducer, undefined, () =>
        savedState(initFields(email, prefillTo, prefillDraft, signatureHtml)),
    );

    // Non-reactive control flow: the in-flight save promise (for serialization) and a kill switch
    // for the send/delete path.
    const inFlightRef = useRef<Promise<EmailDraft> | null>(null);
    const disabledRef = useRef(false);

    // For code that runs after an `await`, where the captured closure may be stale: the timer, the unmount, the send flush.
    const latestRef = useRef({ state, user, onSave });
    latestRef.current = { state, user, onSave };

    const runSave = async (): Promise<EmailDraft | null> => {
        if (disabledRef.current) return null;
        // Serialize: if a save is already in flight, wait for it before starting a new one. This
        // also lets the send path flush any racing auto-save.
        if (inFlightRef.current) {
            await inFlightRef.current.catch(() => {});
            if (disabledRef.current) return null;
        }
        // Read latest fields here, not from closure — the timer that called us may have been
        // queued at an earlier render.
        const { state: s, user: u, onSave: cb } = latestRef.current;
        const fields = s.fields;
        const draft = fieldsToDraft(fields, u);
        const promise = cb(draft, buildSaveOptions(fields));
        inFlightRef.current = promise;
        try {
            const result = await promise;
            dispatch({ type: 'save-completed', sentFields: fields, serverAttachments: result.attachments });
            if (!fields.id) {
                dispatch({ type: 'set-id', id: result.id });
                onDraftIdAssigned?.(result.id);
            }
            return result;
        } catch (error) {
            // The message left Drafts, say through a send in another tab: every later save gets the same answer.
            if (error instanceof AppError && error.status === 409) disabledRef.current = true;
            throw error;
        } finally {
            if (inFlightRef.current === promise) inFlightRef.current = null;
        }
    };

    // Saves a short while after the fields drift from the saved fingerprint. Any newer state resets the timer.
    useEffect(() => {
        if (disabledRef.current) return;
        if (!isSaveable(state.fields)) return;
        if (!isDirty(state)) return;
        const timer = setTimeout(() => void runSave().catch(rethrowUntoasted), AUTO_SAVE_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [state]);

    // Closing the composer saves what the debounce has not reached yet.
    useEffect(() => {
        return () => {
            if (disabledRef.current) return;
            const { state: s, user: u, onSave: cb } = latestRef.current;
            if (!isSaveable(s.fields) || !isDirty(s)) return;
            cb(fieldsToDraft(s.fields, u), buildSaveOptions(s.fields)).catch(rethrowUntoasted);
        };
    }, []);

    // Once the editor has parsed the seeded body and emitted its canonical HTML/text, snap
    // them into state and reset the saved fingerprint. Fires once via LightEditor's onReady.
    const editorReadyRef = useRef(false);
    const markEditorReady = (html: string, text: string) => {
        if (editorReadyRef.current) return;
        editorReadyRef.current = true;
        dispatch({ type: 'sync-editor', html, text });
    };

    return {
        state: state.fields,
        setField: (field: DraftEditableField, value: string) => dispatch({ type: 'set-field', field, value }),
        addAttachment: (meta: AttachmentMeta) => dispatch({ type: 'add-attachment', meta }),
        addPrefillAttachment: (meta: AttachmentMeta) => dispatch({ type: 'add-prefill-attachment', meta }),
        removeAttachment: (index: number) => dispatch({ type: 'remove-attachment', index }),
        addDriveReference: (ref: AttachmentReference) => dispatch({ type: 'add-drive-ref', ref }),
        removeDriveReference: (id: string) => dispatch({ type: 'remove-drive-ref', id }),
        markEditorReady,
        isSendable: !!state.fields.to.trim(),

        // Called when a send is dispatched, not at flush time, so backing out of "Share before sending?" returns to a draft that
        // still auto-saves. The send's own save owns the write from here.
        disableSaves: () => {
            disabledRef.current = true;
        },

        // A rejected send never left, so the draft is still the user's to edit.
        enableSaves: () => {
            disabledRef.current = false;
        },

        // Flushes any pending save and splices in the server's id, since the first save's dispatch may not have rendered yet.
        // Saves stay enabled: the caller disables them only once it commits to sending.
        flushAndGetDraft: async (): Promise<NewDraft> => {
            let result: EmailDraft | null = null;
            if (isDirty(state)) {
                result = await runSave();
            } else if (inFlightRef.current) {
                await inFlightRef.current.catch(() => {});
            }
            // Read latest after the awaits — user may have edited during the in-flight save.
            const { state: s, user: u } = latestRef.current;
            const draft = fieldsToDraft(s.fields, u);
            if (!draft.id && result?.id) draft.id = result.id;
            return draft;
        },
    };
}
