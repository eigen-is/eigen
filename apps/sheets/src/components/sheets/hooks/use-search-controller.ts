import type { DocSearchController, DocSearchMatch } from '@workspace/lib/types/doc-search';
import type { SearchResult, WorkbookInstance } from '@workspace/sheet';
import { type RefObject, useMemo, useRef } from 'react';

function idOf(m: SearchResult): string {
    return `${m.sheetId}:${m.r}:${m.c}`;
}

// Adapts the live WorkbookInstance to the shared DocSearchController. search() is pure (reads the
// engine's searchAll); the id→SearchResult map lets highlightAll/reveal resolve ids back to cells.
// `doc` is identity-only — the editor passes its live flowdata so the controller republishes per
// document change (contract rule 4). The WorkbookInstance ref is re-created on every context
// change, so methods dereference workbookRef.current lazily rather than capturing it.
export function useSheetSearchController(
    workbookRef: RefObject<WorkbookInstance | null>,
    doc: unknown,
): DocSearchController {
    const matches = useRef<Map<string, SearchResult>>(new Map());

    return useMemo<DocSearchController>(() => {
        void doc; // new identity per document change — keeps n of m live (contract rule 4)
        return {
            search(q, opts) {
                const results = workbookRef.current?.searchAll(q, opts) ?? [];
                matches.current = new Map(results.map((m) => [idOf(m), m]));
                return results.map(
                    (m): DocSearchMatch => ({
                        id: idOf(m),
                        label: m.value,
                        context: `${m.sheetName} · ${m.cellPosition}`,
                    }),
                );
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
        };
    }, [workbookRef, doc]);
}
