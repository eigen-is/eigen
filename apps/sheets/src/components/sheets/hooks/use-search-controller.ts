// The sheets editor's side of in-document search: it turns the Workbook's search, reveal and replace into the
// shared search controller that callers such as the find bar and the command palette drive. A match id names its
// cell, so every call works from the id alone.

import type { DocSearchController, DocSearchMatch } from '@workspace/lib/types/doc-search';
import type { SearchResult, WorkbookInstance } from '@workspace/sheet';
import type { RefObject } from 'react';
import { useMemo } from 'react';

// The controller keeps no state of its own. Every id names its cell, and replace is handed the query, because the
// command palette runs its own searches on this controller between the find bar's calls. `doc` is only compared by
// identity: the editor passes its live cells, so the controller is made again after each change and the find bar's
// count stays current. Each call reads workbookRef.current at the time, since a new snapshot mounts a new Workbook.
export function useSheetSearchController(
    workbookRef: RefObject<WorkbookInstance | null>,
    doc: unknown,
    canWrite: boolean,
): DocSearchController {
    return useMemo<DocSearchController>(() => {
        void doc;

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

            // Rewrites every occurrence in the matched cell and returns the matches the edit leaves, which the find bar
            // takes as they are. The Workbook checks the cell against the query again, so an id of a cell that
            // changed since writes nothing and still returns the matches.
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

function toDocMatch(m: SearchResult): DocSearchMatch {
    return { id: idOf(m), label: m.value, context: `${m.sheetName} · ${m.cellPosition}` };
}

function idOf(m: SearchResult): string {
    return `${m.sheetId}:${m.r}:${m.c}`;
}

// The cell an id names. It parses from the right, because a sheet id may itself hold a ':'. A malformed id gives null,
// since the search contract asks every call to tolerate a bad id and never throw. An id of a cell that changed since
// is well formed, and the Workbook then does nothing with it.
function cellOf(id: string): { sheetId: string; r: number; c: number } | null {
    const parts = id.split(':');
    if (parts.length < 3) return null;
    const c = Number(parts.pop());
    const r = Number(parts.pop());
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0) return null;
    return { sheetId: parts.join(':'), r, c };
}
