import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getMailDraftAttachmentUploadUrl, mailApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import type { DraftAttachmentUpload, DraftInput, EmailDraft, NewDraft } from '@workspace/lib/types/mail';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';
import { invalidateHomeSize } from '../../home';
import { emailKeys } from './use-emails';
import { invalidateMailboxes } from './use-mailboxes';

export function createDraftEmail(input: DraftInput): NewDraft {
    return {
        subject: input.subject || '',
        text: input.text || '',
        html: input.html || '',
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
    };
}

type DraftUpdateOptions = {
    tempAttachmentIds?: string[];
    keepAttachmentIndexes?: number[];
    forceFullSave?: boolean;
};

export async function updateDraftEmail(
    draft: NewDraft,
    ownerId: string,
    options: DraftUpdateOptions = {},
): Promise<EmailDraft | null> {
    const response = await mailApi({ ownerId }).message.draft.put({
        mail: draft,
        tempAttachmentIds: options.tempAttachmentIds,
        keepAttachmentIndexes: options.keepAttachmentIndexes,
        forceFullSave: options.forceFullSave,
    });
    if (response.error) throw new AppError(response);
    return response.data || null;
}

export async function sendDraftEmail(draft: NewDraft, ownerId: string): Promise<EmailDraft | null> {
    const response = await mailApi({ ownerId }).message.send.post({
        mail: draft,
    });
    if (response.error) throw new AppError(response);
    return response.data || null;
}

// Multipart upload bypasses Eden Treaty (which serializes bodies as JSON) and goes through raw
// fetch. The response shape is still type-checked against DraftAttachmentUpload.
async function uploadDraftAttachmentRequest(ownerId: string, file: File): Promise<DraftAttachmentUpload> {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(getMailDraftAttachmentUploadUrl(ownerId), {
        method: 'POST',
        body: formData,
        credentials: 'include',
    });
    if (!res.ok) throw new AppError({ status: res.status, error: { status: res.status, value: await res.text() } });
    return (await res.json()) as DraftAttachmentUpload;
}

export function useUpdateDraft() {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: { draft: NewDraft } & DraftUpdateOptions) =>
            updateDraftEmail(input.draft, ownerId, {
                tempAttachmentIds: input.tempAttachmentIds,
                keepAttachmentIndexes: input.keepAttachmentIndexes,
                forceFullSave: input.forceFullSave,
            }),
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, 'Drafts') });
            if (data?.id) queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, data.id) });
            invalidateMailboxes(queryClient, ownerId);
            invalidateHomeSize(queryClient, ownerId);
        },
        onError: onMutationError,
    });
}

export function useSendDraft() {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (draft: NewDraft) => sendDraftEmail(draft, ownerId),
        onSuccess: () => {
            invalidateMailboxes(queryClient, ownerId);
            queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, 'Drafts') });
            invalidateHomeSize(queryClient, ownerId);
            toast.success('Email sent');
        },
        onError: onMutationError,
    });
}

export function useUploadDraftAttachment() {
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: (file: File) => uploadDraftAttachmentRequest(ownerId, file),
        onError: onMutationError,
    });
}
