import { useAuth } from '@workspace/lib/auth';
import type { AttachmentReference } from '@workspace/lib/types/chat';
import type { AddressObject, Attachment, AttachmentMeta, EmailDraft, NewDraft } from '@workspace/lib/types/mail';
import { useCallback, useRef, useState } from 'react';

type DraftState = {
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

function addressObjectToString(addr?: AddressObject): string {
    return addr?.text || '';
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

function initState(email: EmailDraft | null, prefillTo?: string): DraftState {
    if (email) {
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
            driveReferences: [],
            inReplyTo: email.inReplyTo,
            references: email.references,
            messageId: email.messageId,
        };
    }
    return {
        to: prefillTo || '',
        cc: '',
        bcc: '',
        subject: '',
        body: '',
        bodyText: '',
        attachments: [],
        driveReferences: [],
    };
}

export function useDraftState(email: EmailDraft | null, prefillTo?: string) {
    const auth = useAuth();
    const [state, setState] = useState<DraftState>(() => initState(email, prefillTo));

    const stateRef = useRef(state);
    stateRef.current = state;
    const userRef = useRef(auth.user);
    userRef.current = auth.user;

    const setField = useCallback(<K extends keyof DraftState>(field: K, value: DraftState[K]) => {
        setState((prev) => ({ ...prev, [field]: value }));
    }, []);

    const setId = useCallback((id: string) => {
        setState((prev) => ({ ...prev, id }));
    }, []);

    const addAttachment = useCallback((meta: AttachmentMeta) => {
        setState((prev) => ({ ...prev, attachments: [...prev.attachments, meta] }));
    }, []);

    const removeAttachment = useCallback((index: number) => {
        setState((prev) => ({
            ...prev,
            attachments: prev.attachments.filter((_, i) => i !== index),
        }));
    }, []);

    const addDriveReference = useCallback((ref: AttachmentReference) => {
        setState((prev) => ({ ...prev, driveReferences: [...prev.driveReferences, ref] }));
    }, []);

    const removeDriveReference = useCallback((id: string) => {
        setState((prev) => ({
            ...prev,
            driveReferences: prev.driveReferences.filter((r) => r.id !== id),
        }));
    }, []);

    // After a successful save, replace local attachment metas with the freshly-parsed list from
    // the server. Keys are preserved by filename+size where possible so React doesn't remount
    // chips that represent the same attachment across saves.
    const setAttachmentsFromServer = useCallback((parsed: Attachment[]) => {
        setState((prev) => {
            const visible = parsed.filter((a) => !a.contentType.startsWith('text/calendar'));
            const attachments: AttachmentMeta[] = visible.map((a, i) => {
                const filename = a.filename || `Attachment ${i + 1}`;
                const prevMatch = prev.attachments.find((p) => p.filename === filename && p.size === a.size);
                return {
                    key: prevMatch?.key ?? `server-${i}-${filename}-${a.size}`,
                    filename,
                    size: a.size,
                    contentType: a.contentType,
                    index: i,
                    localUrl: prevMatch?.localUrl,
                };
            });
            return { ...prev, attachments };
        });
    }, []);

    const toDraft = useCallback((): NewDraft => {
        const s = stateRef.current;
        const u = userRef.current;
        return {
            id: s.id,
            from: {
                value: [{ name: u?.name || '', address: u?.email || '' }],
                html: '',
                text: '',
            },
            to: stringToAddressObject(s.to),
            cc: stringToAddressObject(s.cc),
            bcc: stringToAddressObject(s.bcc),
            subject: s.subject,
            text: s.bodyText,
            html: s.body,
            inReplyTo: s.inReplyTo,
            references: s.references,
            messageId: s.messageId,
        };
    }, []);

    // Stable serialization of the attachment list for dirty tracking. Covers adds, removes, and
    // the transition from tempId → indexed (after a successful save consumes the temp file).
    const attachmentsFingerprint = useCallback(() => {
        return stateRef.current.attachments.map((a) => `${a.key}:${a.tempId ?? ''}:${a.index ?? ''}`).join('|');
    }, []);

    const isSendable = !!state.to.trim();
    const isSaveable = !!(
        state.to.trim() ||
        state.subject.trim() ||
        state.cc.trim() ||
        state.bcc.trim() ||
        state.bodyText.trim()
    );

    return {
        state,
        setField,
        setId,
        addAttachment,
        removeAttachment,
        addDriveReference,
        removeDriveReference,
        setAttachmentsFromServer,
        toDraft,
        attachmentsFingerprint,
        isSendable,
        isSaveable,
    };
}
