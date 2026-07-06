import type { DocSearchController, DocSearchMatch } from '@workspace/lib/types/doc-search';
import type { SearchResult, WorkbookInstance } from '@workspace/sheet';
import { type RefObject, useMemo } from 'react';

function idOf(m: SearchResult): string {
    return `${m.sheetId}:${m.r}:${m.c}`;
}

// Inverse of idOf, parsed from the right — sheetId may itself contain ':'. Malformed ids return
// null (contract rule 2: tolerate, never throw); stale-but-well-formed cells no-op in the engine.
function cellOf(id: string): { sheetId: string; r: number; c: number } | null {
    const parts = id.split(':');
    if (parts.length < 3) return null;
    const c = Number(parts.pop());
    const r = Number(parts.pop());
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0) return null;
    return { sheetId: parts.join(':'), r, c };
}

function toDocMatch(m: SearchResult): DocSearchMatch {
    return { id: idOf(m), label: m.value, context: `${m.sheetName} · ${m.cellPosition}` };
}

// Adapts the live WorkbookInstance to the shared DocSearchController. STATELESS by design: ids
// parse back to cells (idOf/cellOf) and replace receives the query explicitly, so nothing reads a
// cached last search — the palette interleaves search() calls on this same controller (contract id
// rule). `doc` is identity-only — the editor passes its live flowdata so the controller republishes
// per document change (contract rule 4). The WorkbookInstance ref is re-created on every context
// change, so methods dereference workbookRef.current lazily rather than capturing it.
export function useSheetSearchController(
    workbookRef: RefObject<WorkbookInstance | null>,
    doc: unknown,
    canWrite: boolean,
): DocSearchController {
    return useMemo<DocSearchController>(() => {
        void doc; // new identity per document change — keeps n of m live (contract rule 4)

        const toMatches = (results: SearchResult[]): DocSearchMatch[] => results.map(toDocMatch);

        return {
            search(q, opts) {
                return toMatches(workbookRef.current?.searchAll(q, opts) ?? []);
            },
            highlightAll(found) {
                const cells = found.flatMap((m) => cellOf(m.id) ?? []);
                workbookRef.current?.setSearchHighlights(cells);
            },
            reveal(id) {
                const m = cellOf(id);
                if (m) workbookRef.current?.revealSearchMatch(m);
            },

            canReplace: canWrite,

            // Rewrite the matched cell (every occurrence in it), then adopt the RETURNED fresh list —
            // sheets' React context is a render behind, so the engine computes it on a synchronously
            // produced next-state. A stale id no-ops inside the engine (the cell's value is
            // re-checked against the query there) and still returns the fresh list.
            replace(matchId, query, replacement, opts, preserveCase) {
                const wb = workbookRef.current;
                if (!wb) return [];
                const m = cellOf(matchId);
                if (!m || !canWrite) return toMatches(wb.searchAll(query, opts));
                return toMatches(wb.replace(m, query, replacement, opts, preserveCase));
            },
            replaceAll(query, replacement, opts, preserveCase) {
                const wb = workbookRef.current;
                if (!wb || !canWrite) return { replaced: 0, matches: toMatches(wb?.searchAll(query, opts) ?? []) };
                const { replaced, matches: results } = wb.replaceAll(query, replacement, opts, preserveCase);
                return { replaced, matches: toMatches(results) };
            },
        };
    }, [workbookRef, doc, canWrite]);
}
