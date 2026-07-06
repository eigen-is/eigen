import type { DocCommentMatch, DocCommentSearch } from '@workspace/lib/types/doc-search';
import { useMemo } from 'react';
import { collabApi } from '../../api';
import { AppError } from '../../api-error';

export type DocCommentSearchHalf = Pick<NonNullable<DocCommentSearch>, 'docKey' | 'search'>;

// Shared half of the DocCommentSearch capability: the document-bound async search fn + the docKey
// identity (the OPEN DOCUMENT's coordinates — can differ from the palette's ctx.ownerId on shared
// docs). The app pairs it with its own `reveal` (stickies: chatName → cardId → setOpenCardId; docs:
// comments panel + scroll) to publish a DocCommentSearch. Caching is the palette's job — the IN
// COMMENTS provider wraps `search` in TanStack Query, keyed by docKey + q. Matches only the recent
// ~8 KB tail of each thread (see comments.db v3).
export function useDocCommentSearchHalf(ownerId: string, mountId: string, pathId: string): DocCommentSearchHalf {
    return useMemo(
        () => ({
            docKey: `${ownerId}:${mountId}:${pathId}`,
            search: async (q: string): Promise<DocCommentMatch[]> => {
                const response = await collabApi({ ownerId })({ mountId })({ pathId }).comments.search.get({
                    query: { q },
                });
                if (response.error) throw new AppError(response);
                return response.data;
            },
        }),
        [ownerId, mountId, pathId],
    );
}
