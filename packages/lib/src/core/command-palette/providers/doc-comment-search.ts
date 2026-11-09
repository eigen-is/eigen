// The command palette's In comments section: searches the comment threads of the open document,
// and only in the `doc:` scope, never in the unscoped blend. A document publishes its search as
// ctx.docCommentSearch; this wraps it in TanStack Query so results cache and dedupe, keyed by the
// document's own docKey because ctx.ownerId differs on a shared document.

import { skipToken, useQuery } from '@tanstack/react-query';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { CommandContext, PaletteResult, PaletteScope } from '@workspace/lib/types/command-palette';
import { MessageSquareText } from 'lucide-react';
import { useMemo } from 'react';
import { searchKeys } from '../../search';
import { useDebouncedValue } from '../../use-debounced-value';
import { parseQuery } from '../parse-query';

const DOC_COMMENT_SEARCH_DEBOUNCE_MS = 150;

export function useDocCommentSearchResults(
    ctx: CommandContext,
    input: string,
    scope: PaletteScope | undefined,
): { results: PaletteResult[]; isPending: boolean } {
    const debouncedInput = useDebouncedValue(input, DOC_COMMENT_SEARCH_DEBOUNCE_MS);
    const parsed = parseQuery(debouncedInput);
    const capability = ctx.docCommentSearch;

    const inDocScope = scope === 'doc';
    const enabled = !!capability && inDocScope && parsed.q.length > 0;

    const { data, isFetching } = useQuery({
        queryKey: searchKeys.docComments(capability?.docKey ?? '', parsed.q),
        queryFn: enabled ? () => capability.search(parsed.q) : skipToken,
        staleTime: STALE_TIME.THIRTY_SECONDS,
    });

    const results = useMemo<PaletteResult[]>(() => {
        if (!data) return [];
        return data.map((match, i) => ({
            kind: 'doc-comment-hit' as const,
            id: `doc-comment.${match.id}`,
            title: match.label,
            subtitle: match.context,
            icon: MessageSquareText,
            group: 'doc-comments',
            rank: -i,
            payload: match,
            run: (rctx) => rctx.docCommentSearch?.reveal(match.id),
        }));
    }, [data]);

    const isDebouncing = !!capability && inDocScope && input.trim().length > 0 && input !== debouncedInput;
    return { results, isPending: (enabled && isFetching) || isDebouncing };
}
