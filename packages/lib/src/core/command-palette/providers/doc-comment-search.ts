import { useQuery } from '@tanstack/react-query';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { CommandContext, PaletteResult, PaletteScope } from '@workspace/lib/types/command-palette';
import { MessageSquareText } from 'lucide-react';
import { useMemo } from 'react';
import { searchKeys } from '../../search';
import { useDebouncedValue } from '../../use-debounced-value';
import { parseQuery } from '../parse-query';

// Debounce keystrokes before firing the comment search (matches mail-search's 150ms).
const DOC_COMMENT_SEARCH_DEBOUNCE_MS = 150;

// IN COMMENTS section: async thread search, `doc:` scope ONLY (spec decision #6) — never the global
// unscoped blend; same predicate as the engine filter so the two layers can't disagree. Wraps the
// published capability's bound `search` (GET /collab/…/comments/search) in TanStack Query so the
// section caches + dedupes — keyed by the capability's docKey (the open DOCUMENT's identity;
// ctx.ownerId can differ on shared docs). The caller's useStableWhilePending keeps the last results
// while a new query is in flight. Present only when a document publishes ctx.docCommentSearch.
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
        queryFn: () => capability!.search(parsed.q),
        enabled,
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
