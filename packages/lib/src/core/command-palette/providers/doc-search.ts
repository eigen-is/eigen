import type { CommandContext, PaletteResult, PaletteScope } from '@workspace/lib/types/command-palette';
import { Text } from 'lucide-react';
import { useMemo } from 'react';
import { useDebouncedValue } from '../../use-debounced-value';
import { parseQuery } from '../parse-query';

// In-document hits for the palette `doc:` scope. DocSearchController.search is pure and
// synchronous (no network), so there's no pending state to stabilise — but the input still
// goes through the palette's standard 150 ms debounce like every sibling: an uncapped
// sheet-scale scan per raw keystroke janks. Returns nothing unless a document is open
// (ctx.docSearch published by DocSearchProvider) — so the section is absent in the drive
// list and non-eigendoc apps. The default (all-false) options match the palette's intent
// AND the find bar's DEFAULT_OPTIONS, so revealFromPalette's n of m stays truthful: the
// option toggles live on the find bar, not in the palette.
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
                // Enter/click opens the find bar pre-filled with this query — all matches painted,
                // THIS one active + revealed (n of m at its index) — leaving focus in the document
                // (Reinder, 2026-07-06; was reveal-in-place). q is the debounced term that produced
                // the row; the session resolves match.id to its index.
                run: (rctx) => rctx.docSearchSession?.revealFromPalette(q, match.id),
            }));
    }, [controller, scopeBlocks, q]);
}
