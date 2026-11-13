// Imports a file into an open document, such as a .docx into a doc or an .xlsx into a sheet, from the user's
// computer or from Drive. The server writes it into the document, which saves a version first, so a success
// refreshes the document's row and its version list.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getDriveImportFromDriveUrl, getDriveImportUrl } from '@workspace/lib/api';
import type { DocumentImportOptions, ImportResult } from '@workspace/lib/types/drive-convert';
import { toast } from 'sonner';
import { onMutationError } from '../../api-error';
import { invalidateVersions } from '../../versioning/hooks/keys';
import { invalidatePath } from './keys';

// The import route answers with what the file held that did not come over, such as the tables of a pptx. For a deck
// with no slides it says that nothing came over. The open document shows neither. A plain fetch has no Eden type, so
// the shape is checked here.
async function importResultOf(response: Response): Promise<ImportResult> {
    if (!response.ok) throw new Error(await response.text());
    const body: unknown = await response.json();
    const summary = typeof body === 'object' && body !== null && 'summary' in body ? body.summary : undefined;
    if (summary !== null && typeof summary !== 'string') throw new Error('Unexpected response from the import');
    return { success: true, summary };
}

function toastSummary({ summary }: ImportResult): void {
    if (summary) toast.info(summary);
}

export function useImportDocument(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            pathId,
            file,
            options,
        }: {
            pathId: string;
            file: File;
            options: DocumentImportOptions;
        }) => {
            const url = getDriveImportUrl(ownerId, mountId, pathId, options);
            return importResultOf(await fetch(url, { method: 'POST', body: file, credentials: 'include' }));
        },
        onSuccess: (data, variables) => {
            invalidatePath(queryClient, ownerId, mountId, variables.pathId);
            invalidateVersions(queryClient, ownerId, mountId, variables.pathId);
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
            options,
        }: {
            pathId: string;
            sourceOwnerId: string;
            sourceMountId: string;
            sourcePathId: string;
            options: DocumentImportOptions;
        }) => {
            const url = getDriveImportFromDriveUrl(ownerId, mountId, pathId);
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sourceOwnerId, sourceMountId, sourcePathId, ...options }),
                credentials: 'include',
            });
            return importResultOf(response);
        },
        onSuccess: (data, variables) => {
            invalidatePath(queryClient, ownerId, mountId, variables.pathId);
            invalidateVersions(queryClient, ownerId, mountId, variables.pathId);
            toastSummary(data);
        },
        onError: onMutationError,
    });
}
