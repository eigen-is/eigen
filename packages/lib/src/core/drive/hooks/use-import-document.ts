import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getDriveImportFromDriveUrl, getDriveImportUrl } from '@workspace/lib/api';
import type { ImportResult } from '@workspace/lib/types/drive';
import { toast } from 'sonner';
import { onMutationError } from '../../api-error';
import { driveKeys } from './keys';

// The import route answers with what the file held that did not come over (a pptx's tables, say) or, for a deck with
// no slides, that nothing did: the open document shows neither.
async function importResultOf(response: Response): Promise<ImportResult> {
    if (!response.ok) throw new Error(await response.text());
    return response.json();
}

function toastSummary({ summary }: ImportResult): void {
    if (summary) toast.info(summary);
}

export function useImportDocument(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ pathId, file }: { pathId: string; file: File }) => {
            const url = getDriveImportUrl(ownerId, mountId, pathId);
            return importResultOf(await fetch(url, { method: 'POST', body: file, credentials: 'include' }));
        },
        onSuccess: (data, variables) => {
            queryClient.invalidateQueries({ queryKey: driveKeys.path(ownerId, mountId, variables.pathId) });
            toastSummary(data);
        },
        onError: onMutationError,
    });
}

export function useImportFromDrive(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            pathId,
            sourceOwnerId,
            sourceMountId,
            sourcePathId,
        }: {
            pathId: string;
            sourceOwnerId: string;
            sourceMountId: string;
            sourcePathId: string;
        }) => {
            const url = getDriveImportFromDriveUrl(ownerId, mountId, pathId);
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sourceOwnerId, sourceMountId, sourcePathId }),
                credentials: 'include',
            });
            return importResultOf(response);
        },
        onSuccess: (data, variables) => {
            queryClient.invalidateQueries({ queryKey: driveKeys.path(ownerId, mountId, variables.pathId) });
            toastSummary(data);
        },
        onError: onMutationError,
    });
}
