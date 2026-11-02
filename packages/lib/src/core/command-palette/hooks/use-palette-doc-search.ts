// DocSearchProvider hands the command palette the open document's search: its find controller, the
// find bar's session and the comment-thread search. The palette's `doc:` scope lists in-document
// matches through them and reveals one on Enter. A surface without the palette, such as the help
// center, may mount the find bar too, so with no palette this does nothing.

import type { DocCommentSearch, DocSearchController, DocSearchSession } from '@workspace/lib/types/doc-search';
import { useEffect, useMemo, useRef } from 'react';
import { useOptionalCommandPalette } from './use-command-palette';

// Publishing updates the palette's context, which re-renders the publisher, and an app rebuilds its
// controller from live editor state on every render. So, as usePaletteSelection does, the hook
// stabilises what it publishes: each method calls the latest object through a ref, and the published
// identity changes only when a controller or session appears or goes, or the comment search's
// document changes. Keying the comment search on its docKey makes a document switch in the same
// mount publish again, where a key on presence alone would keep serving the previous document.
export function usePaletteDocSearch(
    controller: DocSearchController | null,
    commentSearch?: DocCommentSearch,
    session?: DocSearchSession,
): void {
    const palette = useOptionalCommandPalette();
    const setDocSearch = palette?.setDocSearch;
    const setDocSearchSession = palette?.setDocSearchSession;
    const setDocCommentSearch = palette?.setDocCommentSearch;

    const controllerRef = useRef<DocSearchController | null>(controller);
    controllerRef.current = controller;
    const commentRef = useRef<DocCommentSearch>(commentSearch ?? null);
    commentRef.current = commentSearch ?? null;
    const sessionRef = useRef<DocSearchSession | null>(session ?? null);
    sessionRef.current = session ?? null;

    const present = controller != null;

    const stable = useMemo<DocSearchController | null>(() => {
        if (!present) return null;
        return {
            search: (query, opts) => controllerRef.current?.search(query, opts) ?? [],
            highlightAll: (matches) => controllerRef.current?.highlightAll(matches),
            reveal: (matchId) => controllerRef.current?.reveal(matchId),
        };
        // `present` is the only meaningful trigger; the live controller routes through the ref.
    }, [present]);

    const sessionPresent = session != null;
    const stableSession = useMemo<DocSearchSession | null>(
        () => (sessionPresent ? { revealFromPalette: (q, id) => sessionRef.current?.revealFromPalette(q, id) } : null),
        [sessionPresent],
    );

    const docKey = commentSearch?.docKey;
    const stableComment = useMemo<DocCommentSearch>(
        () =>
            docKey
                ? {
                      docKey,
                      search: (q) => commentRef.current?.search(q) ?? Promise.resolve([]),
                      reveal: (id) => commentRef.current?.reveal(id),
                  }
                : null,
        [docKey],
    );

    useEffect(() => {
        if (!setDocSearch) return;
        setDocSearch(stable);
        return () => setDocSearch(null);
    }, [stable, setDocSearch]);

    useEffect(() => {
        if (!setDocSearchSession) return;
        setDocSearchSession(stableSession);
        return () => setDocSearchSession(null);
    }, [stableSession, setDocSearchSession]);

    useEffect(() => {
        if (!setDocCommentSearch) return;
        setDocCommentSearch(stableComment);
        return () => setDocCommentSearch(null);
    }, [stableComment, setDocCommentSearch]);
}
