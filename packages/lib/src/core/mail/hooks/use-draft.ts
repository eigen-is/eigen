import { useMutation, useQueryClient } from '@tanstack/react-query';
import { mailApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import type { DraftInput, EmailDraft } from '@workspace/lib/types/mail';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';
import { invalidateHomeSize } from '../../home';
import { emailKeys } from './use-emails';
import { invalidateMailboxes } from './use-mailboxes';

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
        mailbox: 'Drafts',
    };

    return emailDraft as EmailDraft;
}

export async function updateDraftEmail(draft: EmailDraft, ownerId: string): Promise<EmailDraft | null> {
    const response = await mailApi({ ownerId }).message.draft.put({
        mail: draft,
    });
    if (response.error) throw new AppError(response);
    return response.data || null;
}

export async function sendDraftEmail(draft: EmailDraft, ownerId: string): Promise<EmailDraft | null> {
    const response = await mailApi({ ownerId }).message.send.post({
        mail: draft,
    });
    if (response.error) throw new AppError(response);
    return response.data || null;
}

export function useUpdateDraft() {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (draft: EmailDraft) => updateDraftEmail(draft, ownerId),
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, 'Drafts') });
            if (data?.id) queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, data.id) });
        },
        onError: onMutationError,
    });
}

export function useSendDraft() {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (draft: EmailDraft) => sendDraftEmail(draft, ownerId),
        onSuccess: () => {
            invalidateMailboxes(queryClient, ownerId);
            queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, 'Drafts') });
            invalidateHomeSize(queryClient, ownerId);
            toast.success('Email sent');
        },
        onError: onMutationError,
    });
}
