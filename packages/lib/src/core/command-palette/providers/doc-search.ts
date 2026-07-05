import type { CommandContext, PaletteResult, PaletteScope } from '@workspace/lib/types/command-palette';
import { Text } from 'lucide-react';
import { useMemo } from 'react';
import { useDebouncedValue } from '../hooks/use-debounced-value';
import { parseQuery } from '../parse-query';

// In-document hits for the palette `doc:` scope. DocSearchController.search is pure and
// synchronous (no network), so there's no pending state to stabilise — but the input still
// goes through the palette's standard 150 ms debounce like every sibling: an uncapped
// sheet-scale scan per raw keystroke janks. Returns nothing unless a document is open
// (ctx.docSearch published by DocSearchProvider) — so the section is absent in the drive
// list and non-eigendoc apps. The default (all-false) options match the palette's intent:
// the option toggles live on the find bar, not in the palette.
const DOC_SEARCH_DEBOUNCE_MS = 150;
const DOC_OPTIONS = { matchCase: false, wholeWord: false, regex: false };
const DOC_RESULT_CAP = 6;

export function useDocSearchResults(
    ctx: CommandContext,
    input: string,
    scope: PaletteScope | undefined,
): PaletteResult[] {
    const debouncedInput = useDebouncedValue(input, DOC_SEARCH_DEBOUNCE_MS);
    const { q } = parseQuery(debouncedInput);
    const controller = ctx.docSearch;
    const scopeBlocks = !!scope && scope !== 'doc';

    return useMemo<PaletteResult[]>(() => {
        if (!controller || scopeBlocks || q.length === 0) return [];
        return controller
            .search(q, DOC_OPTIONS)
            .slice(0, DOC_RESULT_CAP)
            .map((match, i) => ({
                kind: 'doc-hit' as const,
                id: `doc.${match.id}`,
                title: match.label,
                subtitle: match.context,
                icon: Text,
                group: 'doc-content',
                rank: -i,
                payload: match,
                // Enter reveals the match in place (scroll + flash) via the published controller's
                // reveal — it does NOT open the bar (review decision). ⌘F opens the bar if wanted.
                run: (rctx) => rctx.docSearch?.reveal(match.id),
            }));
    }, [controller, scopeBlocks, q]);
}
