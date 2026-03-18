import {useMutation, useQueryClient} from "@tanstack/react-query";
import {api} from "../../api";
import {driveKeys} from "../../drive/hooks/use-drive";
import {editorKeys} from "./use-file-content";

type SaveParams = {
    content: string;
    frontmatter?: string;
    expectedUpdatedAt: string;
    force?: boolean;
};

export function useFileSave(ownerId: string, mountId: string, pathId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (params: SaveParams) => {
            const res = await api.editor({ownerId})({mountId})({pathId}).content.put(params);
            if (res.error || !res.data) throw new Error(String(res.error ?? 'Save failed'));
            return res.data;
        },
        onSuccess: (data) => {
            if (!data.conflict) {
                queryClient.invalidateQueries({queryKey: driveKeys.path(ownerId, mountId, pathId)});
                queryClient.invalidateQueries({queryKey: editorKeys.content(ownerId, mountId, pathId)});
            }
        },
    });
}
