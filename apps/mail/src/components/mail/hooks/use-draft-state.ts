import { useAuth } from '@workspace/lib/auth';
import { createDraftEmail } from '@workspace/lib/mail';
import type { AddressObject, AttachmentMeta, EmailDraft, NewDraft } from '@workspace/lib/types/mail';
import { useCallback, useRef, useState } from 'react';

type DraftState = {
    id?: string;
    to: string;
    cc: string;
    bcc: string;
    subject: string;
    body: string;
    attachments: AttachmentMeta[];
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
            attachments: (email.attachments || []).map((a, i) => ({
                filename: a.filename || `Attachment ${i + 1}`,
                size: a.size,
                contentType: a.contentType,
                index: i,
            })),
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
        attachments: [],
    };
}

export function useDraftState(email: EmailDraft | null, prefillTo?: string) {
    const auth = useAuth();
    const [state, setState] = useState<DraftState>(() => initState(email, prefillTo));

    const stateRef = useRef(state);
    stateRef.current = state;
    const emailRef = useRef(email);
    emailRef.current = email;
    const userRef = useRef(auth.user);
    userRef.current = auth.user;

    const setField = useCallback(<K extends keyof DraftState>(field: K, value: DraftState[K]) => {
        setState((prev) => ({ ...prev, [field]: value }));
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

    const toDraft = useCallback((): NewDraft | EmailDraft => {
        const s = stateRef.current;
        const e = emailRef.current;
        const u = userRef.current;
        const from = {
            value: [{ name: u?.name || '', address: u?.email || '' }],
            html: '',
            text: '',
        };
        const base = e ? { ...e } : createDraftEmail({});

        return {
            ...base,
            id: s.id,
            from,
            to: stringToAddressObject(s.to),
            cc: stringToAddressObject(s.cc),
            bcc: stringToAddressObject(s.bcc),
            subject: s.subject,
            text: s.body
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim(),
            html: s.body,
            inReplyTo: s.inReplyTo,
            references: s.references,
            messageId: s.messageId,
        };
    }, []);

    const bodyText = state.body.replace(/<[^>]+>/g, '').trim();
    const isSendable = !!state.to.trim();
    const isSaveable = !!(state.to.trim() || state.subject.trim() || state.cc.trim() || state.bcc.trim() || bodyText);

    return {
        state,
        setField,
        addAttachment,
        removeAttachment,
        toDraft,
        isSendable,
        isSaveable,
    };
}
