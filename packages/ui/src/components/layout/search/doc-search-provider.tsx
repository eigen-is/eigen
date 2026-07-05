import { useHotkey } from '@tanstack/react-hotkeys';
import { usePaletteDocSearch } from '@workspace/lib/command-palette';
import type { DocSearchController, DocSearchMatch, DocSearchOptions } from '@workspace/lib/types/doc-search';
import { FindReplaceBar } from '@workspace/ui/components/layout/search/find-replace-bar';
import { cn } from '@workspace/ui/lib/utils';
import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

const DEFAULT_OPTIONS: DocSearchOptions = { matchCase: false, wholeWord: false, regex: false };
const DEBOUNCE_MS = 150;

export type DocSearchBarContextValue = {
    open: () => void; // open the bar (or re-focus + select it when already open) — ⌘F / toolbar ⌕ / Edit-menu
};

const DocSearchBarContext = createContext<DocSearchBarContextValue | null>(null);

export function useDocSearchBar(): DocSearchBarContextValue {
    const ctx = useContext(DocSearchBarContext);
    if (!ctx) throw new Error('useDocSearchBar must be used inside <DocSearchProvider>');
    return ctx;
}

// Null-safe variant (the useOptionalCommandPalette pattern) for chrome that renders
// with and without a provider — toolbar ⌕ buttons, the sheets Edit-menu item.
export function useOptionalDocSearchBar(): DocSearchBarContextValue | null {
    return useContext(DocSearchBarContext);
}

export type DocSearchProviderProps = {
    controller: DocSearchController;
    // A ?q= landing term: open the bar pre-filled, highlight all, reveal the first match — focus
    // stays in the document (the bar input is NOT focused on this path). Latched once by the route.
    initialSearchTerm?: string;
    children: React.ReactNode;
    // Per-surface bar placement (amendment 10): the default floats top-right of the wrapped subtree;
    // a surface passes offsets to clear its own chrome (docs insets it below the toolbar + clear of
    // the side panel). Merged over the default via cn, so later utilities win.
    barClassName?: string;
    // Notifies a surface whose Escape is layered (slides: present → edit → bar → deselect) when the
    // bar opens/closes, so its own document-level Escape can defer to the bar-close instead of running
    // its default action. The bar owns closing itself; this is read-only awareness.
    onOpenChange?: (open: boolean) => void;
};

// Owns the find session (open state, query, options, matches, active index), the keybinds, and the
// floating bar. Surfaces implement the DocSearchController over their live state and republish it
// (new identity) when the document changes; the provider re-runs the open session's search on that
// identity change so the count stays live while a collaborator types.
// Accepted quirk: the active match is tracked by INDEX, so under remote collab edits it may drift to
// a different occurrence when the controller republishes; reveal is best-effort. Surface controllers
// debounce remote-origin republish coarsely (not per remote keystroke) to keep count/paint settled.
export function DocSearchProvider({
    controller,
    initialSearchTerm,
    children,
    barClassName,
    onOpenChange,
}: DocSearchProviderProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [options, setOptions] = useState<DocSearchOptions>(DEFAULT_OPTIONS);
    const [matches, setMatches] = useState<DocSearchMatch[]>([]);
    const [activeIndex, setActiveIndex] = useState(-1);

    const inputRef = useRef<HTMLInputElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const controllerRef = useRef(controller);
    controllerRef.current = controller;
    const sessionRef = useRef({ open, query, options });
    sessionRef.current = { open, query, options };
    // Focus + select the input after the bar mounts. Set for ⌘F / the toolbar seam; left false for a
    // ⌘G reopen so stepping never steals focus from the document (contract rule for reveal).
    const pendingFocusRef = useRef(false);

    // Run a search and paint results. revealIndex = which match to make active + reveal afterwards
    // (clamped to range).
    const runSearch = useCallback((q: string, opts: DocSearchOptions, revealIndex: number) => {
        const c = controllerRef.current;
        const found = c.search(q, opts);
        setMatches(found);
        c.highlightAll(found);
        if (found.length === 0) {
            setActiveIndex(-1);
            return;
        }
        const idx = Math.min(Math.max(revealIndex, 0), found.length - 1);
        setActiveIndex(idx);
        c.reveal(found[idx].id);
    }, []);

    const scheduleSearch = useCallback(
        (q: string, opts: DocSearchOptions) => {
            clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => runSearch(q, opts, 0), DEBOUNCE_MS);
        },
        [runSearch],
    );

    useEffect(() => () => clearTimeout(debounceRef.current), []);

    useEffect(() => {
        onOpenChange?.(open);
    }, [open, onOpenChange]);

    // Focus once the bar has mounted (inputRef is null on the render that flips `open`).
    useEffect(() => {
        if (open && pendingFocusRef.current) {
            pendingFocusRef.current = false;
            inputRef.current?.focus();
            inputRef.current?.select();
        }
    }, [open]);

    // ?q= landing: open the bar pre-filled, paint all, reveal the first match. pendingFocusRef stays
    // false so focus stays in the document (Esc dismisses). Runs once on mount — the route latches
    // the term, and runSearch/setQuery/setOpen are all stable, so there's nothing to re-run on.
    useEffect(() => {
        if (initialSearchTerm && initialSearchTerm !== '') {
            setQuery(initialSearchTerm);
            setOpen(true);
            runSearch(initialSearchTerm, DEFAULT_OPTIONS, 0);
        }
    }, [initialSearchTerm, runSearch]);

    // Surfaces republish their controller when the document changes — re-run the open session's
    // search so n of m stays live. Clamp the index; do NOT reveal (don't yank the user's scroll).
    useEffect(() => {
        const t = setTimeout(() => {
            const session = sessionRef.current;
            if (!session.open || session.query === '') return;
            const found = controller.search(session.query, session.options);
            setMatches(found);
            controller.highlightAll(found);
            setActiveIndex((prev) => (found.length === 0 ? -1 : Math.min(Math.max(prev, 0), found.length - 1)));
        }, DEBOUNCE_MS);
        return () => clearTimeout(t);
    }, [controller]);

    const close = useCallback(() => {
        clearTimeout(debounceRef.current);
        controllerRef.current.highlightAll([]);
        setOpen(false);
        setMatches([]);
        setActiveIndex(-1);
    }, []);

    const openBar = useCallback(
        (focus: boolean) => {
            if (open) {
                if (focus) {
                    inputRef.current?.focus();
                    inputRef.current?.select();
                }
                return;
            }
            pendingFocusRef.current = focus;
            setOpen(true);
            // retained query from a previous session — re-run so we don't flash a stale "No results".
            if (query !== '') scheduleSearch(query, options);
        },
        [open, query, options, scheduleSearch],
    );

    const step = useCallback(
        (delta: number) => {
            if (matches.length === 0) return;
            const next = (activeIndex + delta + matches.length) % matches.length;
            setActiveIndex(next);
            controllerRef.current.reveal(matches[next].id);
        },
        [matches, activeIndex],
    );

    // ⌘G / ⇧⌘G. Bar open → step. Bar closed (with a retained query — the only case the hotkey is
    // enabled) → reopen WITHOUT focusing the input, run the search now, and land on the first (next)
    // or last (prev) match.
    const findStep = useCallback(
        (delta: number) => {
            if (open) {
                step(delta);
                return;
            }
            pendingFocusRef.current = false;
            setOpen(true);
            runSearch(query, options, delta > 0 ? 0 : Number.MAX_SAFE_INTEGER);
        },
        [open, step, query, options, runSearch],
    );

    useHotkey('Mod+F', (e) => {
        e.preventDefault();
        openBar(true);
    });
    useHotkey(
        'Mod+G',
        (e) => {
            e.preventDefault();
            findStep(1);
        },
        { enabled: open || query !== '' },
    );
    useHotkey(
        'Mod+Shift+G',
        (e) => {
            e.preventDefault();
            findStep(-1);
        },
        { enabled: open || query !== '' },
    );
    // Escape fires in inputs by @tanstack/hotkeys default; the bar input also wires Esc→close on its
    // own onKeyDown (belt-and-suspenders + so per-surface layered-Escape plans can gate this one).
    useHotkey(
        'Escape',
        (e) => {
            if (!open) return;
            e.preventDefault();
            close();
        },
        { enabled: open },
    );

    const onQueryChange = useCallback(
        (q: string) => {
            setQuery(q);
            scheduleSearch(q, options);
        },
        [options, scheduleSearch],
    );

    // Side effects stay OUT of state-updater functions (scheduleSearch here, reveal in step).
    const onToggleOption = useCallback(
        (key: keyof DocSearchOptions) => {
            const next = { ...options, [key]: !options[key] };
            setOptions(next);
            scheduleSearch(query, next);
        },
        [options, query, scheduleSearch],
    );

    const barContext = useMemo(() => ({ open: () => openBar(true) }), [openBar]);

    // Publish the per-app controller so the palette `doc:` scope can list in-document matches and
    // reveal one in place. usePaletteDocSearch stabilises it by shape, so the publish effect doesn't
    // loop even though the app rebuilds the controller each render. The palette hit's run() calls
    // controller.reveal(matchId) — reveal in place, no bar (review decision).
    usePaletteDocSearch(controller);

    return (
        <DocSearchBarContext.Provider value={barContext}>
            <div className="relative flex h-full min-h-0 flex-col">
                {/* isolate the CHILDREN subtree — the sheet engine's cellArea overlays (z 8–30) must
                    not share a stacking context with the bar */}
                <div className="isolate flex-1 min-h-0">{children}</div>
                {open && (
                    <div className={cn('absolute top-2 right-4 z-10 max-sm:inset-x-2', barClassName)}>
                        <FindReplaceBar
                            query={query}
                            options={options}
                            matchCount={matches.length}
                            activeIndex={activeIndex}
                            inputRef={inputRef}
                            onQueryChange={onQueryChange}
                            onToggleOption={onToggleOption}
                            onNext={() => step(1)}
                            onPrev={() => step(-1)}
                            onClose={close}
                        />
                    </div>
                )}
            </div>
        </DocSearchBarContext.Provider>
    );
}
