import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getDriveAppUrl, getMailDraftAttachmentUploadUrl, mailApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import type {
    DraftAttachmentUpload,
    DraftInput,
    EmailDraft,
    NewDraft,
    SentMailResult,
} from '@workspace/lib/types/mail';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';
import { invalidateItemCreated } from '../../drive/hooks/keys';
import { invalidateHomeSize } from '../../home';
import { emailKeys, invalidateMailboxes } from './keys';

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

export async function sendDraftEmail(draft: NewDraft, ownerId: string): Promise<SentMailResult | null> {
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
        // Optimistically merge the user's edits into the cached detail. This matters for
        // fire-and-forget unmount saves: if the user navigates away then immediately back, the
        // detail query is observed before the network save completes, and useEmail's
        // staleTime: Infinity would otherwise serve the pre-edit copy. Fields are assigned
        // directly (no `?? previous` fallback) so that *clearing* a field — e.g. removing the
        // sole recipient, where draft.to becomes undefined — propagates to the cache rather
        // than silently reverting to the previous value.
        onMutate: ({ draft }) => {
            if (!draft.id) return;
            const key = emailKeys.detail(ownerId, draft.id);
            const previous = queryClient.getQueryData<EmailDraft | null>(key);
            if (!previous) return;
            queryClient.setQueryData<EmailDraft | null>(key, {
                ...previous,
                subject: draft.subject ?? '',
                // to/cc/bcc are direct assignments — undefined means the user cleared the
                // field (stringToAddressObject returns undefined for empty input).
                to: draft.to,
                cc: draft.cc,
                bcc: draft.bcc,
                text: draft.text ?? '',
                html: draft.html ?? '',
                driveReferences: draft.driveReferences ?? previous.driveReferences,
            });
        },
        onSuccess: (data) => {
            // Push the parsed response into the cache so the next observe doesn't need a
            // refetch. The list still gets invalidated because per-message metadata (date,
            // attachment count) may have changed.
            if (data?.id) queryClient.setQueryData(emailKeys.detail(ownerId, data.id), data);
            queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, 'Drafts') });
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
        onSuccess: (data) => {
            invalidateMailboxes(queryClient, ownerId);
            queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, 'Drafts') });
            invalidateHomeSize(queryClient, ownerId);
            if (data?.failedRecipients?.length) {
                toast.error(`Delivery to ${data.failedRecipients.join(', ')} failed`);
            } else {
                toast.success('Email sent');
            }
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

export function useAttachFromDrive() {
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (source: { sourceOwnerId: string; sourceMountId: string; sourcePathId: string }) => {
            const response = await mailApi({ ownerId }).message.draft['attachment-from-drive'].post(source);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onError: onMutationError,
    });
}

export function useSaveMailAttachmentsToDrive() {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({
            messageId,
            indexes,
            targetOwnerId,
            targetMountId,
            targetParentId,
        }: {
            messageId: string;
            indexes: number[];
            targetOwnerId: string;
            targetMountId: string;
            targetParentId: string;
        }) => {
            const response = await mailApi({ ownerId }).message({ id: messageId }).attachments['save-to-drive'].post({
                indexes,
                targetOwnerId,
                targetMountId,
                targetParentId,
            });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, variables) => {
            invalidateItemCreated(
                queryClient,
                variables.targetOwnerId,
                variables.targetMountId,
                variables.targetParentId,
            );
            const count = variables.indexes.length;
            toast.success(count === 1 ? 'Attachment saved to Drive' : `${count} attachments saved to Drive`, {
                action: {
                    label: 'Open folder',
                    onClick: () => {
                        window.location.href = getDriveAppUrl(
                            `fs/${variables.targetOwnerId}/${variables.targetMountId}/${variables.targetParentId}`,
                        );
                    },
                },
            });
        },
        onError: onMutationError,
    });
}
