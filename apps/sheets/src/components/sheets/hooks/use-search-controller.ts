import type { DocSearchController, DocSearchMatch } from '@workspace/lib/types/doc-search';
import type { SearchResult, WorkbookInstance } from '@workspace/sheet';
import { type RefObject, useMemo, useRef } from 'react';

function idOf(m: SearchResult): string {
    return `${m.sheetId}:${m.r}:${m.c}`;
}

function toDocMatch(m: SearchResult): DocSearchMatch {
    return { id: idOf(m), label: m.value, context: `${m.sheetName} · ${m.cellPosition}` };
}

// Adapts the live WorkbookInstance to the shared DocSearchController. search() is pure (reads the
// engine's searchAll); the id→SearchResult map lets highlightAll/reveal/replace resolve ids back to
// cells. `doc` is identity-only — the editor passes its live flowdata so the controller republishes
// per document change (contract rule 4). The WorkbookInstance ref is re-created on every context
// change, so methods dereference workbookRef.current lazily rather than capturing it.
export function useSheetSearchController(
    workbookRef: RefObject<WorkbookInstance | null>,
    doc: unknown,
    canWrite: boolean,
): DocSearchController {
    const matches = useRef<Map<string, SearchResult>>(new Map());
    // The query the last search() ran with. replace() gets opts but not the query (the contract's
    // matchId self-describes the cell, not the term), so it reads the term the current matches came
    // from — always in sync, since the provider searches before it can replace.
    const lastQuery = useRef('');

    return useMemo<DocSearchController>(() => {
        void doc; // new identity per document change — keeps n of m live (contract rule 4)

        const remap = (results: SearchResult[]): DocSearchMatch[] => {
            matches.current = new Map(results.map((m) => [idOf(m), m]));
            return results.map(toDocMatch);
        };

        return {
            search(q, opts) {
                lastQuery.current = q;
                return remap(workbookRef.current?.searchAll(q, opts) ?? []);
            },
            highlightAll(found) {
                const cells = found
                    .map((m) => matches.current.get(m.id))
                    .filter((m): m is SearchResult => m != null)
                    .map((m) => ({ sheetId: m.sheetId, r: m.r, c: m.c }));
                workbookRef.current?.setSearchHighlights(cells);
            },
            reveal(id) {
                const m = matches.current.get(id);
                if (m) workbookRef.current?.revealSearchMatch({ sheetId: m.sheetId, r: m.r, c: m.c });
            },

            canReplace: canWrite,

            // Rewrite the matched cell (every occurrence in it), then adopt the RETURNED fresh list —
            // sheets' React context is a render behind, so the engine computes it on a synchronously
            // produced next-state. A stale id (not in the current map) no-ops with a plain re-search.
            replace(matchId, replacement, opts, preserveCase) {
                const wb = workbookRef.current;
                if (!wb || !canWrite) return remap(wb?.searchAll(lastQuery.current, opts) ?? []);
                const m = matches.current.get(matchId);
                if (!m) return remap(wb.searchAll(lastQuery.current, opts));
                return remap(
                    wb.replace(
                        { sheetId: m.sheetId, r: m.r, c: m.c },
                        lastQuery.current,
                        replacement,
                        opts,
                        preserveCase,
                    ),
                );
            },
            replaceAll(query, replacement, opts, preserveCase) {
                const wb = workbookRef.current;
                if (!wb || !canWrite) return { replaced: 0, matches: remap(wb?.searchAll(query, opts) ?? []) };
                const { replaced, matches: results } = wb.replaceAll(query, replacement, opts, preserveCase);
                return { replaced, matches: remap(results) };
            },
        };
    }, [workbookRef, doc, canWrite]);
}
