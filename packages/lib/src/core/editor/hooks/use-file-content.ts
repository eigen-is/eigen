import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { AppError } from '../../api-error';
import { editorKeys } from './keys';

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
