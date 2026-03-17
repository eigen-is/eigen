import {useMutation} from '@tanstack/react-query';
import {mailApi} from '@workspace/lib/api';
import type {DraftInput, EmailDraft} from '@workspace/lib/types/mail';
import {useAuth} from '@workspace/lib/auth';

export function createDraftEmail(input: DraftInput): EmailDraft {
    const emailDraft: Partial<EmailDraft> = {
        id: undefined,
        subject: input.subject || '',
        text: input.text || '',
        from: undefined,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        isDraft: true,
        mailbox: 'Drafts'
    };

    return emailDraft as EmailDraft;
}

export async function updateDraftEmail(draft: EmailDraft, ownerId: string): Promise<EmailDraft | null> {
    try {
        const response = await mailApi({ownerId}).message.draft.put({
            mail: draft
        });
        return response.data || null;
    } catch (error) {
        console.error('Error updating draft:', error);
        return null;
    }
}

export async function sendDraftEmail(draft: EmailDraft, ownerId: string): Promise<EmailDraft | null> {
    try {
        const response = await mailApi({ownerId}).message.send.post({
            mail: draft
        });
        return response.data || null;
    } catch (error) {
        console.error('Error sending draft:', error);
        return null;
    }
}

export function useUpdateDraft() {
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: (draft: EmailDraft) => updateDraftEmail(draft, ownerId),
    });
}

export function useSendDraft() {
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: (draft: EmailDraft) => sendDraftEmail(draft, ownerId),
    });
}
