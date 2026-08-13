import type { QueryClient } from '@tanstack/react-query';

export const editorKeys = {
    all: ['editor'] as const,
    owner: (ownerId: string) => [...editorKeys.all, ownerId] as const,
    content: (ownerId: string, mountId: string, pathId: string) =>
        [...editorKeys.owner(ownerId), 'content', mountId, pathId] as const,
};

export function invalidateEditorContent(queryClient: QueryClient, ownerId: string, mountId: string, pathId: string) {
    queryClient.invalidateQueries({ queryKey: editorKeys.content(ownerId, mountId, pathId) });
}
