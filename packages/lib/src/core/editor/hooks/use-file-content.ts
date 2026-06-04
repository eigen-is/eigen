import { type QueryClient, useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { AppError } from '../../api-error';

export const editorKeys = {
    all: ['editor'] as const,
    owner: (ownerId: string) => [...editorKeys.all, ownerId] as const,
    content: (ownerId: string, mountId: string, pathId: string) =>
        [...editorKeys.owner(ownerId), 'content', mountId, pathId] as const,
};

export function invalidateEditorContent(queryClient: QueryClient, ownerId: string, mountId: string, pathId: string) {
    queryClient.invalidateQueries({ queryKey: editorKeys.content(ownerId, mountId, pathId) });
}

export function useFileContent(ownerId: string, mountId: string, pathId: string) {
    return useQuery({
        queryKey: editorKeys.content(ownerId, mountId, pathId),
        queryFn: async () => {
            const res = await api.editor({ ownerId })({ mountId })({ pathId }).content.get();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        staleTime: 0,
        enabled: !!ownerId && !!mountId && !!pathId,
    });
}
