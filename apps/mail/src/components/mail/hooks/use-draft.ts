import { type AuthUser, useAuth } from '@workspace/lib/auth';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import type { AddressObject, Attachment, AttachmentMeta, EmailDraft, NewDraft } from '@workspace/lib/types/mail';
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
    messageId?: string;
};

type DraftEditableField = 'to' | 'cc' | 'bcc' | 'subject' | 'body' | 'bodyText';

type DraftState = {
    fields: DraftFields;
    // Fingerprint of the fields the server actually has. Drift from this triggers an auto-save.
    lastSavedFingerprint: string;
};

type SaveOptions = {
    tempAttachmentIds?: string[];
    keepAttachmentIndexes?: number[];
    forceFullSave?: boolean;
};

type SaveFn = (draft: NewDraft, options?: SaveOptions) => Promise<EmailDraft | null | undefined>;

type Action =
    | { type: 'set-field'; field: DraftEditableField; value: string }
    | { type: 'set-id'; id: string }
    | { type: 'add-attachment'; meta: AttachmentMeta }
    | { type: 'remove-attachment'; index: number }
    | { type: 'add-drive-ref'; ref: AttachmentReference }
    | { type: 'remove-drive-ref'; id: string }
    | { type: 'sync-editor'; html: string; text: string }
    | { type: 'save-completed'; sentFields: DraftFields; serverAttachments: Attachment[] };

type UseDraftOptions = {
    email: EmailDraft | null;
    prefillTo?: string;
    // Seed the composer with quoted body / subject / recipients for reply/forward, without
    // persisting a draft until the user actually edits. lastSavedFingerprint is computed from
    // these fields so no save fires on mount.
    prefillDraft?: NewDraft;
    signatureHtml?: string;
    onSave?: SaveFn;
    onDraftIdAssigned?: (id: string) => void;
};

function addressObjectToString(addr?: AddressObject): string {
    if (!addr) return '';
    if (addr.text) return addr.text;
    // Fall back to the value list when text is empty — reply-all builds AddressObjects with only
    // `value` populated. Inverse of stringToAddressObject: `name <address>`, else bare address.
    return addr.value
        .map((a) => (a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')))
        .filter(Boolean)
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
    return { value, html: text, text };
}

// Canonical empty paragraph — matches TipTap's normalized form so the seeded body survives
// first interaction without the editor rewriting it (which would otherwise diff as a user
// edit and trip the auto-save fingerprint).
const EMPTY_PARA = '<p><br></p>';

function injectSignature(body: string, sig: string | undefined, kind: 'new' | 'reply'): string {
    if (!sig) return body;
    if (kind === 'new') return body + EMPTY_PARA + sig;
    // formatEmailQuote prefixes the quoted body with <br><br>; bare <br>s between block
    // elements aren't canonical and TipTap rewrites them on first edit. Strip them and use
    // one explicit empty paragraph for the breathing room between sig and quote.
    const trimmed = body.replace(/^(<br\s*\/?>)+/i, '');
    return EMPTY_PARA + sig + EMPTY_PARA + trimmed;
}

// Mirror TipTap getText(): block boundaries become \n\n, <br> becomes \n. Keeps the seeded
// bodyText close to what the editor will emit so the auto-save fingerprint stays stable
// when the user first interacts. Covers the block elements LightEditor exposes (p, blockquote,
// ul/ol/li); inline marks (strong, em, link) need no special handling.
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
            subject: email.subject ? String(email.subject) : '',
            body: email.html || email.text || '',
            bodyText: email.text || '',
            attachments: (email.attachments || []).map((a, i) => ({
                key: `saved-${i}-${a.filename ?? ''}-${a.size}`,
                filename: a.filename || `Attachment ${i + 1}`,
                size: a.size,
                contentType: a.contentType,
                index: i,
            })),
            driveReferences: email.driveReferences ?? [],
            inReplyTo: email.inReplyTo,
            references: email.references,
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

function fingerprintFields(f: DraftFields): string {
    const attachments = f.attachments.map((a) => `${a.key}:${a.tempId ?? ''}:${a.index ?? ''}`).join('|');
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
            html: '',
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
        messageId: f.messageId,
        driveReferences: f.driveReferences,
    };
}

function buildSaveOptions(fields: DraftFields, forceFullSave: boolean): SaveOptions {
    const tempIds = fields.attachments.map((a) => a.tempId).filter((id): id is string => !!id);
    const keepIdx = fields.attachments.map((a) => a.index).filter((i): i is number => typeof i === 'number');
    return {
        tempAttachmentIds: tempIds.length ? tempIds : undefined,
        // Always send the keep list when the draft has an id — an empty array means "user removed
        // all original attachments", which we must respect.
        keepAttachmentIndexes: fields.id ? keepIdx : undefined,
        forceFullSave,
    };
}

// Reconcile the server's response with edits made while the save was in flight. `serverActual`
// is what the server has now (with local keys preserved by filename+size so React chips don't
// remount). `localNext` is the user's intent — serverActual minus attachments removed during
// the save, plus tempId attachments added during the save. Drift between the two naturally
// re-triggers the auto-save to sync the server.
function mergeServerAttachments(
    local: AttachmentMeta[],
    sent: AttachmentMeta[],
    parsed: Attachment[],
): { serverActual: AttachmentMeta[]; localNext: AttachmentMeta[] } {
    const visible = parsed.filter((a) => !a.contentType.startsWith('text/calendar'));
    const serverActual = visible.map((a, i) => {
        const filename = a.filename || `Attachment ${i + 1}`;
        const prevMatch = local.find((p) => p.filename === filename && p.size === a.size);
        return {
            key: prevMatch?.key ?? `server-${i}-${filename}-${a.size}`,
            filename,
            size: a.size,
            contentType: a.contentType,
            index: i,
            localUrl: prevMatch?.localUrl,
        };
    });

    const removedDuringSave = sent.filter((s) => !local.some((l) => l.filename === s.filename && l.size === s.size));
    const withoutRemoved = serverActual.filter(
        (a) => !removedDuringSave.some((r) => r.filename === a.filename && r.size === a.size),
    );
    const inFlightAdditions = local.filter(
        (l) => !!l.tempId && !visible.some((a) => (a.filename ?? '') === l.filename && a.size === l.size),
    );

    return { serverActual, localNext: [...withoutRemoved, ...inFlightAdditions] };
}

function reducer(state: DraftState, action: Action): DraftState {
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
            // Snapshot the editor's canonical HTML/text post-parse and reset the saved
            // fingerprint to match. Without this, TipTap's normalisation of the seeded body
            // (or its emission of the quoted-content text via getText) drifts from the seed
            // on first interaction and tricks the auto-save into firing without any user edit.
            const fields = { ...state.fields, body: action.html, bodyText: action.text };
            return { fields, lastSavedFingerprint: fingerprintFields(fields) };
        }
        case 'save-completed': {
            const { serverActual, localNext } = mergeServerAttachments(
                state.fields.attachments,
                action.sentFields.attachments,
                action.serverAttachments,
            );
            // The fingerprint reflects what the server actually has: the fields we sent + the
            // server's post-parse attachment list. Edits made during the save will diff against
            // this and trigger another save automatically.
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

const noopSave: SaveFn = () => Promise.resolve(null);

export function useDraft({
    email,
    prefillTo,
    prefillDraft,
    signatureHtml,
    onSave = noopSave,
    onDraftIdAssigned,
}: UseDraftOptions) {
    const { user } = useAuth();
    const [state, dispatch] = useReducer(reducer, undefined, () => {
        const fields = initFields(email, prefillTo, prefillDraft, signatureHtml);
        return { fields, lastSavedFingerprint: fingerprintFields(fields) };
    });

    // Non-reactive control flow: the in-flight save promise (for serialization), a kill switch
    // for the send/delete path, and a "anything ever saved" flag (drives the unmount-save
    // heuristic — we force a full EML rebuild even when the current state matches the server,
    // so Dovecot IMAP clients see fresh content).
    const inFlightRef = useRef<Promise<EmailDraft | null | undefined> | null>(null);
    const disabledRef = useRef(false);
    const everSavedRef = useRef(false);

    // Latest-state mirror — used by code that runs after an `await` (auto-save timer firing,
    // unmount cleanup, the send-path flush) where the captured closure may be stale by render
    // count or many edits.
    const latestRef = useRef({ state, user, onSave });
    latestRef.current = { state, user, onSave };

    const runSave = async (options: { forceFullSave?: boolean } = {}): Promise<EmailDraft | null | undefined> => {
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
        const promise = cb(draft, buildSaveOptions(fields, options.forceFullSave === true));
        inFlightRef.current = promise;
        try {
            const result = await promise;
            everSavedRef.current = true;
            if (result) {
                dispatch({
                    type: 'save-completed',
                    sentFields: fields,
                    serverAttachments: result.attachments ?? [],
                });
                if (!fields.id && result.id) {
                    dispatch({ type: 'set-id', id: result.id });
                    onDraftIdAssigned?.(result.id);
                }
            }
            return result;
        } finally {
            if (inFlightRef.current === promise) inFlightRef.current = null;
        }
    };

    // Auto-save: schedule a debounced save whenever fields drift from the saved fingerprint.
    // Each render either (a) nothing changed → the cleanup runs without setting a new timer, or
    // (b) state changed → the cleanup clears the previous timer and we set a new one.
    useEffect(() => {
        if (disabledRef.current) return;
        if (!isSaveable(state.fields)) return;
        if (fingerprintFields(state.fields) === state.lastSavedFingerprint) return;
        const timer = setTimeout(() => void runSave(), AUTO_SAVE_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [state]);

    // Save on unmount — force a full EML rebuild so IMAP clients see fresh content. Fires when
    // the current state is dirty OR anything was saved during this session.
    useEffect(() => {
        return () => {
            if (disabledRef.current) return;
            const { state: s, user: u, onSave: cb } = latestRef.current;
            if (!isSaveable(s.fields)) return;
            const dirty = fingerprintFields(s.fields) !== s.lastSavedFingerprint;
            if (!dirty && !everSavedRef.current) return;
            cb(fieldsToDraft(s.fields, u), buildSaveOptions(s.fields, true)).catch((err) =>
                console.warn('draft unmount save failed', err),
            );
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
        setField: <K extends DraftEditableField>(field: K, value: string) =>
            dispatch({ type: 'set-field', field, value }),
        addAttachment: (meta: AttachmentMeta) => dispatch({ type: 'add-attachment', meta }),
        removeAttachment: (index: number) => dispatch({ type: 'remove-attachment', index }),
        addDriveReference: (ref: AttachmentReference) => dispatch({ type: 'add-drive-ref', ref }),
        removeDriveReference: (id: string) => dispatch({ type: 'remove-drive-ref', id }),
        markEditorReady,
        isSendable: !!state.fields.to.trim(),

        // Kill auto-save + unmount-save. Called the moment a send is actually dispatched, NOT at
        // flush time — so abandoning a send-time dialog ("Share before sending?") returns to a draft
        // that still auto-saves. A dispatched send navigates away and its own draftFullSave owns the
        // write, so no unmount save should fire behind it.
        disableSaves: () => {
            disabledRef.current = true;
        },

        // A rejected send never left, so the draft is still the user's to edit.
        enableSaves: () => {
            disabledRef.current = false;
        },

        // Send path: flush any pending/in-flight save and return a NewDraft with the server-assigned
        // id spliced in (the dispatch from the first save may not have rendered yet — callers can't
        // await React state propagation). Saves stay enabled; the caller disables them via
        // disableSaves() only once it commits to sending.
        flushAndGetDraft: async (): Promise<NewDraft> => {
            let result: EmailDraft | null | undefined = null;
            if (fingerprintFields(state.fields) !== state.lastSavedFingerprint) {
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
