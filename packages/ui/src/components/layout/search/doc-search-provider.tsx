import { useHotkey } from '@tanstack/react-hotkeys';
import { usePaletteDocSearch } from '@workspace/lib/command-palette';
import type {
    DocCommentSearch,
    DocSearchController,
    DocSearchMatch,
    DocSearchOptions,
} from '@workspace/lib/types/doc-search';
import { FindReplaceBar } from '@workspace/ui/components/layout/search/find-replace-bar';
import { cn } from '@workspace/ui/lib/utils';
import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

const DEFAULT_OPTIONS: DocSearchOptions = { matchCase: false, wholeWord: false, regex: false };
const DEBOUNCE_MS = 150;

export type DocSearchBarContextValue = {
    open: () => void; // open the bar (or re-focus + select it when already open) — ⌘F / toolbar ⌕ / Edit-menu
    openReplace: () => void; // open in replace mode when the surface canReplace, else plain search — ⌥⌘F / Edit-menu
    canReplace: boolean; // lets chrome (Edit menu) hide "Find and replace" on read-only surfaces
};

const DocSearchBarContext = createContext<DocSearchBarContextValue | null>(null);

// Null-safe variant (the useOptionalCommandPalette pattern) for chrome that renders
// with and without a provider — toolbar ⌕ buttons, the sheets Edit-menu item.
export function useOptionalDocSearchBar(): DocSearchBarContextValue | null {
    return useContext(DocSearchBarContext);
}

export type DocSearchProviderProps = {
    controller: DocSearchController;
    // Optional comment-thread search capability (stickies + docs today). Published alongside the
    // controller so the palette `doc:` scope gains its async IN COMMENTS section; apps that omit it
    // publish null and nothing changes for them.
    commentSearch?: DocCommentSearch;
    // A ?q= landing term: open the bar pre-filled, highlight all, reveal the first match — focus
    // stays in the document (the bar input is NOT focused on this path). Latched once by the route.
    initialSearchTerm?: string;
    children: React.ReactNode;
    // Per-surface bar placement (amendment 10): the default floats top-right of the wrapped subtree;
    // a surface passes offsets to clear its own chrome (docs insets it below the toolbar + clear of
    // the side panel). Merged over the default via cn, so later utilities win.
    barClassName?: string;
    // Notifies the host when the bar opens/closes. Slides uses it for layered-Escape awareness (present
    // → edit → bar → deselect); docs, sheets and slides also use it to close the mobile pane, so a
    // session never opens inside the hidden editor. The bar owns closing itself.
    onOpenChange?: (open: boolean) => void;
    // The surface's own undo/redo, routed out of the bar's inputs (⌘Z / ⇧⌘Z) so Replace stays
    // undoable without leaving the bar. Passed straight to FindReplaceBar; omitted by search-only
    // surfaces (slides/stickies), where the default keeps native behaviour.
    onUndo?: () => void;
    onRedo?: () => void;
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
    commentSearch,
    initialSearchTerm,
    children,
    barClassName,
    onOpenChange,
    onUndo,
    onRedo,
}: DocSearchProviderProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [options, setOptions] = useState<DocSearchOptions>(DEFAULT_OPTIONS);
    const [matches, setMatches] = useState<DocSearchMatch[]>([]);
    const [activeIndex, setActiveIndex] = useState(-1);
    // v1.5 replace session state. mode is 'search' until ⌥⌘F / the chevron opens replace;
    // replacedCount is the transient "Replaced N" the bar shows after Replace All.
    const [mode, setMode] = useState<'search' | 'replace'>('search');
    const [replacement, setReplacement] = useState('');
    const [preserveCase, setPreserveCase] = useState(false);
    const [replacedCount, setReplacedCount] = useState<number | null>(null);
    const canReplace = controller.canReplace ?? false;
    // ⌥⌘F everywhere; Mod+H only off macOS (plain ⌘H is macOS Hide, never reaches the page).
    const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');

    const inputRef = useRef<HTMLInputElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const replacedTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const controllerRef = useRef(controller);
    controllerRef.current = controller;
    const sessionRef = useRef({ open, query, options });
    sessionRef.current = { open, query, options };
    // Focus + select the input after the bar mounts. Set for ⌘F / the toolbar seam; left false for a
    // ⌘G reopen so stepping never steals focus from the document (contract rule for reveal).
    const pendingFocusRef = useRef(false);

    // Run a search and paint results. revealTarget = which match to make active + reveal afterwards:
    // an index (clamped to range) or a match id (the palette hit — resolved to its index, fallback 0
    // when it's gone, since collab may have shifted the doc since the palette searched).
    const runSearch = useCallback((q: string, opts: DocSearchOptions, revealTarget: number | { matchId: string }) => {
        const c = controllerRef.current;
        const found = c.search(q, opts);
        setMatches(found);
        c.highlightAll(found);
        if (found.length === 0) {
            setActiveIndex(-1);
            return;
        }
        const raw =
            typeof revealTarget === 'number'
                ? revealTarget
                : Math.max(
                      found.findIndex((m) => m.id === revealTarget.matchId),
                      0,
                  );
        const idx = Math.min(Math.max(raw, 0), found.length - 1);
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

    // A palette IN DOCUMENT hit: adopt the palette's query, paint all, reveal the CLICKED match (n of
    // m at its index). Focus stays in the document (pendingFocusRef false) — the ?q= landing shape.
    // The palette searches with all-false options, so reset to DEFAULT_OPTIONS or the count would lie.
    // Runs the search now (not debounced) so the reveal lands on this interaction.
    const revealFromPalette = useCallback(
        (paletteQuery: string, matchId: string) => {
            clearTimeout(debounceRef.current);
            clearTimeout(replacedTimeoutRef.current);
            setQuery(paletteQuery);
            setOptions(DEFAULT_OPTIONS);
            setReplacedCount(null);
            pendingFocusRef.current = false;
            setOpen(true);
            runSearch(paletteQuery, DEFAULT_OPTIONS, { matchId });
        },
        [runSearch],
    );

    useEffect(
        () => () => {
            clearTimeout(debounceRef.current);
            clearTimeout(replacedTimeoutRef.current);
        },
        [],
    );

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
    // Throttle, not debounce: slides/stickies republish per Yjs transaction, so a sustained remote
    // edit stream would reset a trailing debounce forever and freeze the session (the F1 shape). A
    // scheduled tick is never cancelled by the next republish — it reads the live controllerRef.
    const republishTickRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => {
        void controller;
        if (republishTickRef.current !== undefined) return;
        republishTickRef.current = setTimeout(() => {
            republishTickRef.current = undefined;
            const session = sessionRef.current;
            if (!session.open || session.query === '') return;
            const c = controllerRef.current;
            const found = c.search(session.query, session.options);
            setMatches(found);
            c.highlightAll(found);
            setActiveIndex((prev) => (found.length === 0 ? -1 : Math.min(Math.max(prev, 0), found.length - 1)));
        }, DEBOUNCE_MS);
    }, [controller]);
    useEffect(() => () => clearTimeout(republishTickRef.current), []);

    const close = useCallback(() => {
        clearTimeout(debounceRef.current);
        clearTimeout(replacedTimeoutRef.current);
        controllerRef.current.highlightAll([]);
        setOpen(false);
        setMatches([]);
        setActiveIndex(-1);
        setMode('search');
        setReplacedCount(null);
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

    // Adopt the fresh post-edit match list the controller RETURNS — never re-run controller.search
    // after an edit (sheets' React context is one render behind then). nextIndex null → nothing active.
    const adoptMatches = useCallback((fresh: DocSearchMatch[], nextIndex: number | null) => {
        setMatches(fresh);
        setActiveIndex(nextIndex ?? -1);
        controllerRef.current.highlightAll(fresh);
        if (nextIndex != null && fresh[nextIndex]) controllerRef.current.reveal(fresh[nextIndex].id);
    }, []);

    const flashReplaced = useCallback((n: number) => {
        setReplacedCount(n);
        clearTimeout(replacedTimeoutRef.current);
        replacedTimeoutRef.current = setTimeout(() => setReplacedCount(null), 2000);
    }, []);

    const onReplace = useCallback(() => {
        const c = controllerRef.current;
        if (!c.replace || activeIndex < 0 || !matches[activeIndex]) return;
        const fresh = c.replace(matches[activeIndex].id, query, replacement, options, preserveCase);
        // Advance rule: keep the index only when a match was consumed (count dropped) — the next
        // match shifted into it. If the count held (cat→cats still matches), step forward, or Replace
        // loops on the same match forever.
        const consumed = fresh.length < matches.length;
        const next =
            fresh.length === 0
                ? null
                : consumed
                  ? Math.min(activeIndex, fresh.length - 1)
                  : (activeIndex + 1) % fresh.length;
        setReplacedCount(null);
        clearTimeout(replacedTimeoutRef.current);
        adoptMatches(fresh, next);
    }, [activeIndex, matches, query, replacement, options, preserveCase, adoptMatches]);

    const onReplaceAll = useCallback(() => {
        const c = controllerRef.current;
        if (!c.replaceAll) return;
        const { replaced, matches: fresh } = c.replaceAll(query, replacement, options, preserveCase);
        // Skipped formula/locked cells may remain matched — activate the first so the count never
        // reads "0 of N" and Replace/next stay live on the residue.
        adoptMatches(fresh, fresh.length > 0 ? 0 : null);
        flashReplaced(replaced);
    }, [query, replacement, options, preserveCase, adoptMatches, flashReplaced]);

    // Shared by the ⌥⌘F / Win-Linux Mod+H hotkeys and the Edit-menu item: open the bar in replace
    // mode when the surface supports it, else plain search (read-only docs/sheets, slides, stickies).
    const openReplace = useCallback(() => {
        setMode(controllerRef.current.canReplace ? 'replace' : 'search');
        openBar(true);
    }, [openBar]);

    useHotkey('Mod+F', (e) => {
        e.preventDefault();
        openBar(true);
    });
    // ⌥⌘F on macOS, Ctrl+Alt+F elsewhere (order-free at runtime)
    useHotkey('Mod+Alt+F', (e) => {
        e.preventDefault();
        openReplace();
    });
    useHotkey(
        'Mod+H',
        (e) => {
            e.preventDefault();
            openReplace();
        },
        { enabled: !isMac },
    );
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
            setReplacedCount(null); // a new search invalidates the "Replaced N" feedback
            clearTimeout(replacedTimeoutRef.current);
            scheduleSearch(q, options);
        },
        [options, scheduleSearch],
    );

    const toggleMode = useCallback(() => setMode((m) => (m === 'search' ? 'replace' : 'search')), []);
    const togglePreserveCase = useCallback(() => setPreserveCase((p) => !p), []);

    // Side effects stay OUT of state-updater functions (scheduleSearch here, reveal in step).
    const onToggleOption = useCallback(
        (key: keyof DocSearchOptions) => {
            const next = { ...options, [key]: !options[key] };
            setOptions(next);
            scheduleSearch(query, next);
        },
        [options, query, scheduleSearch],
    );

    const barContext = useMemo(
        () => ({ open: () => openBar(true), openReplace, canReplace }),
        [openBar, openReplace, canReplace],
    );

    // Publish the per-app controller so the palette `doc:` scope can list in-document matches, plus
    // the session's revealFromPalette so a hit's run() opens THIS bar pre-filled + reveals the match
    // (Reinder, 2026-07-06; was reveal-in-place). usePaletteDocSearch stabilises both by shape, so the
    // publish effect doesn't loop even though the app rebuilds the controller each render.
    usePaletteDocSearch(controller, commentSearch, { revealFromPalette });

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
                            mode={mode}
                            replacement={replacement}
                            preserveCase={preserveCase}
                            canReplace={canReplace}
                            replacedCount={replacedCount}
                            onReplacementChange={setReplacement}
                            onTogglePreserveCase={togglePreserveCase}
                            onToggleMode={toggleMode}
                            onReplace={onReplace}
                            onReplaceAll={onReplaceAll}
                            onUndo={onUndo}
                            onRedo={onRedo}
                        />
                    </div>
                )}
            </div>
        </DocSearchBarContext.Provider>
    );
}
