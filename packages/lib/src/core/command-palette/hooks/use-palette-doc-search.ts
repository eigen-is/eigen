import type { DocCommentSearch, DocSearchController, DocSearchSession } from '@workspace/lib/types/doc-search';
import { useEffect, useMemo, useRef } from 'react';
import { useOptionalCommandPalette } from './use-command-palette';

// DocSearchProvider publishes its per-app controller so the palette `doc:` scope can list
// in-document matches and reveal one in place on Enter. Mirrors usePaletteSelectionActions:
// the controller's identity churns per render (apps rebuild it from live editor state), and
// publishing into context re-renders the publisher — so without stabilisation the publication
// effect would refire every render and trip React's max-update guard. We stabilise: every
// method routes through a ref to the latest controller, and the published identity only flips
// when a controller appears/disappears. Optional palette (a surface may mount the bar without
// the full EigenApp stack — index/support have no palette), so no-op when there's no provider.
// commentSearch is the app's optional { docKey, search, reveal } comment-thread capability
// (docKey + search = useDocCommentSearchHalf bound to the open doc; reveal is app-specific);
// published as ctx.docCommentSearch, stabilised the same way but keyed on docKey so a same-mount
// doc switch republishes (a presence-only key would keep serving the previous doc's docKey).
// session is the provider's find-bar reveal capability (revealFromPalette); published as
// ctx.docSearchSession and stabilised by presence like the controller.
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
                      search: (q) => commentRef.current!.search(q),
                      reveal: (id) => commentRef.current!.reveal(id),
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
