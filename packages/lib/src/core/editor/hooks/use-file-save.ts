// The mutation that saves a text file from Drive's inline editor. It sends the content and the etag the
// editor loaded, and returns the server's answer: the new etag, or a conflict. A save that landed
// refreshes the file's row and its editor content.

import type { UseMutationResult } from '@tanstack/react-query';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { EditorSaveResult } from '@workspace/lib/types/drive';
import { api } from '../../api';
import { AppError, onMutationError } from '../../api-error';
import { invalidatePath } from '../../drive/hooks/keys';
import { invalidateEditorContent } from './keys';

type SaveParams = {
    content: string;
    frontmatter?: string;
    expectedEtag: string;
    force?: boolean;
};

export function useFileSave(
    ownerId: string,
    mountId: string,
    pathId: string,
): UseMutationResult<EditorSaveResult, unknown, SaveParams> {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (params: SaveParams) => {
            const res = await api.editor({ ownerId })({ mountId })({ pathId }).content.put(params);
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: (data) => {
            if (!data.conflict) {
                invalidatePath(queryClient, ownerId, mountId, pathId);
                invalidateEditorContent(queryClient, ownerId, mountId, pathId);
            }
        },
        onError: onMutationError,
    });
}
