import type { EmailDraft, NewDraft } from '@workspace/lib/types/mail';
import { useCallback, useEffect, useRef } from 'react';

type AutoSaveOptions = {
    toDraft: () => NewDraft | EmailDraft;
    isSaveable: boolean;
    draftId?: string;
    onSave: (draft: NewDraft | EmailDraft) => Promise<unknown>;
    onIdAssigned?: (id: string) => void;
    debounceMs?: number;
};

export function useDraftAutoSave({
    toDraft,
    isSaveable,
    draftId,
    onSave,
    onIdAssigned,
    debounceMs = 2500,
}: AutoSaveOptions) {
    const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const lastSavedRef = useRef<string>('');
    const savingRef = useRef(false);

    const doSave = useCallback(async () => {
        if (savingRef.current) return;
        const draft = toDraft();
        const snapshot = JSON.stringify({
            to: draft.to,
            cc: draft.cc,
            bcc: draft.bcc,
            subject: draft.subject,
            text: draft.text,
            html: draft.html,
        });
        if (snapshot === lastSavedRef.current) return;

        savingRef.current = true;
        try {
            const result = await onSave(draft);
            lastSavedRef.current = snapshot;
            if (!draftId && result && typeof result === 'object' && 'id' in result) {
                onIdAssigned?.(result.id as string);
            }
        } finally {
            savingRef.current = false;
        }
    }, [toDraft, onSave, draftId, onIdAssigned]);

    const scheduleSave = useCallback(() => {
        if (!isSaveable) return;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(doSave, debounceMs);
    }, [doSave, isSaveable, debounceMs]);

    // Save on unmount
    useEffect(() => {
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            if (isSaveable && !savingRef.current) {
                const draft = toDraft();
                const snapshot = JSON.stringify({
                    to: draft.to,
                    cc: draft.cc,
                    bcc: draft.bcc,
                    subject: draft.subject,
                    text: draft.text,
                    html: draft.html,
                });
                if (snapshot !== lastSavedRef.current) {
                    onSave(draft).catch(() => {});
                }
            }
        };
    }, []);

    return { scheduleSave, saveNow: doSave };
}
