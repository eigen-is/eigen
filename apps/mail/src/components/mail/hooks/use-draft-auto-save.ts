import type { EmailDraft, NewDraft } from '@workspace/lib/types/mail';
import { useCallback, useEffect, useRef } from 'react';

type AutoSaveOptions = {
    toDraft: () => NewDraft;
    attachmentsFingerprint: () => string;
    isSaveable: boolean;
    draftId?: string;
    onSave?: (draft: NewDraft) => Promise<EmailDraft | null | undefined | unknown>;
    onIdAssigned?: (id: string) => void;
    debounceMs?: number;
};

const noopSave = () => Promise.resolve(null);

function buildSnapshot(draft: NewDraft, attachmentsFingerprint: string): string {
    return JSON.stringify({
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        text: draft.text,
        html: draft.html,
        attachments: attachmentsFingerprint,
    });
}

export function useDraftAutoSave({
    toDraft,
    attachmentsFingerprint,
    isSaveable,
    draftId,
    onSave = noopSave,
    onIdAssigned,
    debounceMs = 2500,
}: AutoSaveOptions) {
    const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    // Seed with the initial snapshot so opening an existing draft doesn't trigger a no-op save.
    const lastSavedRef = useRef<string>(buildSnapshot(toDraft(), attachmentsFingerprint()));
    const inFlightRef = useRef<Promise<unknown> | null>(null);
    const disabledRef = useRef(false);

    const toDraftRef = useRef(toDraft);
    toDraftRef.current = toDraft;
    const fingerprintRef = useRef(attachmentsFingerprint);
    fingerprintRef.current = attachmentsFingerprint;
    const onSaveRef = useRef(onSave);
    onSaveRef.current = onSave;
    const onIdAssignedRef = useRef(onIdAssigned);
    onIdAssignedRef.current = onIdAssigned;
    const isSaveableRef = useRef(isSaveable);
    isSaveableRef.current = isSaveable;
    const draftIdRef = useRef(draftId);
    draftIdRef.current = draftId;

    const doSave = useCallback(async (): Promise<unknown> => {
        if (disabledRef.current) return null;
        // Serialize saves: if one is already running, await it before starting a new one.
        // This lets saveNow() from the send path flush any racing auto-save.
        if (inFlightRef.current) {
            await inFlightRef.current.catch(() => {});
            if (disabledRef.current) return null;
        }
        const draft = toDraftRef.current();
        const snapshot = buildSnapshot(draft, fingerprintRef.current());
        if (snapshot === lastSavedRef.current) return null;

        const promise = (async () => {
            const result = await onSaveRef.current(draft);
            lastSavedRef.current = snapshot;
            if (!draftIdRef.current && result && typeof result === 'object' && 'id' in result) {
                onIdAssignedRef.current?.(result.id as string);
            }
            return result;
        })();
        inFlightRef.current = promise;
        try {
            return await promise;
        } finally {
            if (inFlightRef.current === promise) inFlightRef.current = null;
        }
    }, []);

    const scheduleSave = useCallback(() => {
        if (disabledRef.current || !isSaveableRef.current) return;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(doSave, debounceMs);
    }, [doSave, debounceMs]);

    // Disable future saves — called when the draft is about to be sent or deleted,
    // preventing pending timers, the unmount save, and any queued saveNow.
    const disable = useCallback(() => {
        disabledRef.current = true;
        if (timerRef.current) clearTimeout(timerRef.current);
    }, []);

    // Save on unmount — refs ensure we use latest state/handlers, not stale mount-time closure.
    useEffect(() => {
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            if (disabledRef.current || !isSaveableRef.current) return;
            const draft = toDraftRef.current();
            const snapshot = buildSnapshot(draft, fingerprintRef.current());
            if (snapshot !== lastSavedRef.current) {
                onSaveRef.current(draft).catch((err) => console.warn('draft unmount save failed', err));
            }
        };
    }, []);

    return { scheduleSave, saveNow: doSave, disable };
}
