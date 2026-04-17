import type { EmailDraft, NewDraft } from '@workspace/lib/types/mail';
import { useCallback, useEffect, useRef } from 'react';

type AutoSaveOptions = {
    toDraft: () => NewDraft | EmailDraft;
    isSaveable: boolean;
    draftId?: string;
    onSave?: (draft: NewDraft | EmailDraft) => Promise<unknown>;
    onIdAssigned?: (id: string) => void;
    debounceMs?: number;
};

const noopSave = () => Promise.resolve();

export function useDraftAutoSave({
    toDraft,
    isSaveable,
    draftId,
    onSave = noopSave,
    onIdAssigned,
    debounceMs = 2500,
}: AutoSaveOptions) {
    const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const lastSavedRef = useRef<string>('');
    const savingRef = useRef(false);
    const disabledRef = useRef(false);

    const toDraftRef = useRef(toDraft);
    toDraftRef.current = toDraft;
    const onSaveRef = useRef(onSave);
    onSaveRef.current = onSave;
    const onIdAssignedRef = useRef(onIdAssigned);
    onIdAssignedRef.current = onIdAssigned;
    const isSaveableRef = useRef(isSaveable);
    isSaveableRef.current = isSaveable;
    const draftIdRef = useRef(draftId);
    draftIdRef.current = draftId;

    const pendingAttachmentsRef = useRef(false);
    const setHasPendingAttachments = useCallback((has: boolean) => {
        pendingAttachmentsRef.current = has;
    }, []);

    const buildSnapshot = (draft: NewDraft | EmailDraft) =>
        JSON.stringify({
            to: draft.to,
            cc: draft.cc,
            bcc: draft.bcc,
            subject: draft.subject,
            text: draft.text,
            html: draft.html,
        });

    const doSave = useCallback(async (): Promise<unknown> => {
        if (savingRef.current || disabledRef.current) return null;
        const draft = toDraftRef.current();
        const snapshot = buildSnapshot(draft);
        if (snapshot === lastSavedRef.current && !pendingAttachmentsRef.current) return null;

        savingRef.current = true;
        try {
            const result = await onSaveRef.current(draft);
            lastSavedRef.current = snapshot;
            pendingAttachmentsRef.current = false;
            if (!draftIdRef.current && result && typeof result === 'object' && 'id' in result) {
                onIdAssignedRef.current?.(result.id as string);
            }
            return result;
        } finally {
            savingRef.current = false;
        }
    }, []);

    const scheduleSave = useCallback(() => {
        if (disabledRef.current || !isSaveableRef.current) return;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(doSave, debounceMs);
    }, [doSave, debounceMs]);

    // Disable future saves — called when the draft is about to be sent or deleted,
    // preventing both pending timers and the unmount save from resurrecting the draft.
    const disable = useCallback(() => {
        disabledRef.current = true;
        if (timerRef.current) clearTimeout(timerRef.current);
    }, []);

    // Save on unmount — refs ensure we use latest state/handlers, not stale mount-time closure.
    useEffect(() => {
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            if (disabledRef.current) return;
            if (isSaveableRef.current && !savingRef.current) {
                const draft = toDraftRef.current();
                const snapshot = buildSnapshot(draft);
                if (snapshot !== lastSavedRef.current) {
                    onSaveRef.current(draft).catch(() => {});
                }
            }
        };
    }, []);

    return { scheduleSave, saveNow: doSave, disable, setHasPendingAttachments };
}
