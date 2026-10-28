// The find bar every document app shares, such as Docs and Sheets: DocSearchProvider owns one find session, its
// keys and the floating bar, and searches through the DocSearchController the app implements over its live
// document. Chrome such as an Edit menu or a toolbar button opens the bar through useOptionalDocSearchBar.

import { useHotkey } from '@tanstack/react-hotkeys';
import { usePaletteDocSearch } from '@workspace/lib/command-palette';
import type {
    DocCommentSearch,
    DocSearchController,
    DocSearchMatch,
    DocSearchOptions,
} from '@workspace/lib/types/doc-search';
import { FindReplaceBar } from '@workspace/ui/components/search/find-replace-bar';
import { useDialogOpen } from '@workspace/ui/hooks/use-dialog-open';
import { cn } from '@workspace/ui/lib/utils';
import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

// The find bar's own shortcuts, which the Edit menus show next to Find and Find and replace.
export const FIND_HOTKEY = 'Mod+F';
export const FIND_REPLACE_HOTKEY = 'Mod+Shift+H';

const DEFAULT_OPTIONS: DocSearchOptions = { matchCase: false, wholeWord: false, regex: false };
const DEBOUNCE_MS = 150;

export type DocSearchBarContextValue = {
    // Opens the bar, or focuses and selects its field when it is open, as ⌘F, a toolbar button or Edit › Find do.
    open: () => void;
    // Opens the bar to replace where the surface can, and to search where it can't, as ⇧⌘H does.
    openReplace: () => void;
    // Lets chrome such as an Edit menu hide Find and replace on a read-only surface.
    canReplace: boolean;
};

const DocSearchBarContext = createContext<DocSearchBarContextValue | null>(null);

// The bar for chrome that renders both inside and outside a provider, such as a toolbar's find button. Outside one
// it is null, as useOptionalCommandPalette is.
export function useOptionalDocSearchBar(): DocSearchBarContextValue | null {
    return useContext(DocSearchBarContext);
}

export type DocSearchProviderProps = {
    controller: DocSearchController;
    // A search of the comment threads, for an app that has them, such as Docs. It is published with the controller,
    // so the palette's `doc:` scope gains its In comments section. An app without it publishes null.
    commentSearch?: DocCommentSearch;
    // A ?q= term the page opened with. The bar opens with it, every match is highlighted and the first is revealed.
    // The focus stays in the document, not in the bar's field. The route latches it once.
    initialSearchTerm?: string;
    children: React.ReactNode;
    // Where the bar floats. By default it sits at the top right of the wrapped content, and a surface passes offsets
    // to clear its own chrome, such as Docs' toolbar and side panel. It is merged over the default with cn.
    barClassName?: string;
    // Tells the host when the bar opens or closes. Slides uses it to know which layer an Escape closes, and an app
    // may use it to close its phone pane, so a find session never opens inside a hidden editor. The bar closes
    // itself.
    onOpenChange?: (open: boolean) => void;
    // The surface's own undo and redo, which ⌘Z and ⇧⌘Z in the bar's fields call, so a Replace can be undone
    // without leaving the bar. A surface that only searches leaves them out and keeps the browser's own.
    onUndo?: () => void;
    onRedo?: () => void;
};

// Owns the find session, its keys and the floating bar. A surface implements the DocSearchController over its live
// state and hands in a new one when the document changes. The provider then runs the open session's search again,
// so the count stays live while a collaborator types. The active match is kept by its index, so a collaborator's
// edit may move it to another occurrence, and a reveal is best effort. A surface hands in a new controller for a
// collaborator's edits only now and then, not per keystroke, so the count and the highlights stay settled.
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
    // The mode is search until ⇧⌘H or the chevron opens replace. The replaced count is the "Replaced N" the bar shows
    // for a while after Replace all.
    const [mode, setMode] = useState<'search' | 'replace'>('search');
    const [replacement, setReplacement] = useState('');
    const [preserveCase, setPreserveCase] = useState(false);
    const [replacedCount, setReplacedCount] = useState<number | null>(null);
    const canReplace = controller.canReplace ?? false;
    // ⇧⌘H opens replace everywhere, as in Google Docs, whose ⌥⌘F inserts a footnote. Ctrl+H does too off macOS.
    // On macOS ⌘H hides the app and never reaches the page.
    const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');

    const inputRef = useRef<HTMLInputElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const replacedTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const controllerRef = useRef(controller);
    controllerRef.current = controller;
    const sessionRef = useRef({ open, query, options });
    sessionRef.current = { open, query, options };
    // Whether the field is focused and selected once the bar mounts. ⌘F and the toolbar set it. A ⌘G reopen leaves it
    // off, so stepping through matches never takes the focus from the document.
    const pendingFocusRef = useRef(false);

    // Runs a search and highlights the matches, then makes one active and reveals it. That one is an index, clamped
    // to the matches, or a palette hit's match id. A hit that is gone reveals the first match, as a collaborator may
    // have changed the doc since the palette searched.
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

    // A palette hit in the document opens the bar with the palette's query and reveals the match that was clicked.
    // The focus stays in the document, as for a ?q= term. The palette searches without options, so the options go
    // back to their defaults, or the count would be wrong. The search runs at once, so the reveal answers the click.
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

    // The field exists only once the bar has mounted, after the render that opens it.
    useEffect(() => {
        if (open && pendingFocusRef.current) {
            pendingFocusRef.current = false;
            inputRef.current?.focus();
            inputRef.current?.select();
        }
    }, [open]);

    // A ?q= term opens the bar with it and reveals the first match, with the focus left in the document. It runs once,
    // as the route latches the term and runSearch is stable.
    useEffect(() => {
        if (initialSearchTerm && initialSearchTerm !== '') {
            setQuery(initialSearchTerm);
            setOpen(true);
            runSearch(initialSearchTerm, DEFAULT_OPTIONS, 0);
        }
    }, [initialSearchTerm, runSearch]);

    // A new controller means the document changed, so the open session searches again and its count stays live. The
    // active index is clamped but not revealed, which would scroll the page away from the reader. This is a
    // throttle, not a debounce. Some surfaces hand in a controller per Yjs transaction, so a steady stream of a
    // collaborator's edits would push a debounce back forever. A scheduled tick is never canceled and reads the
    // latest controller.
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
            // A query kept from an earlier session runs again, so the bar never shows a stale "No results".
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

    // ⌘G and ⇧⌘G step through the matches while the bar is open. With the bar closed they work only for a kept query:
    // the bar opens without focusing its field, the search runs at once, and the first or the last match is active.
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

    // Takes the matches a replace returned. The provider never searches again right after an edit, as a surface's
    // React state, such as Sheets', is one render behind then. A null index leaves no match active.
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
        // When the replace removed a match, the next one moved into its index, which stays. When the count held,
        // such as cat replaced by cats, the index steps forward, or Replace would loop on the same match.
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
        // A cell the replace skipped, such as a formula, may still match. The first match is made active, so the count
        // never reads "0 of N" and Replace and Next still work on what is left.
        adoptMatches(fresh, fresh.length > 0 ? 0 : null);
        flashReplaced(replaced);
    }, [query, replacement, options, preserveCase, adoptMatches, flashReplaced]);

    // The replace keys and Edit › Find and replace open the bar to replace, or to search on a surface that can't
    // replace, such as a read-only doc.
    const openReplace = useCallback(() => {
        setMode(controllerRef.current.canReplace ? 'replace' : 'search');
        openBar(true);
    }, [openBar]);

    // The keys listen on the document; behind an open dialog the bar would open unseen.
    const dialogOpen = useDialogOpen();
    useHotkey(
        FIND_HOTKEY,
        (e) => {
            e.preventDefault();
            openBar(true);
        },
        { enabled: !dialogOpen },
    );
    useHotkey(
        FIND_REPLACE_HOTKEY,
        (e) => {
            e.preventDefault();
            openReplace();
        },
        { enabled: !dialogOpen },
    );
    useHotkey(
        'Mod+H',
        (e) => {
            e.preventDefault();
            openReplace();
        },
        { enabled: !isMac && !dialogOpen },
    );
    useHotkey(
        'Mod+G',
        (e) => {
            e.preventDefault();
            findStep(1);
        },
        { enabled: (open || query !== '') && !dialogOpen },
    );
    useHotkey(
        'Mod+Shift+G',
        (e) => {
            e.preventDefault();
            findStep(-1);
        },
        { enabled: (open || query !== '') && !dialogOpen },
    );
    // The hotkeys library fires Escape in a field too. The bar's field closes the bar on Escape as well, so a surface
    // with layers of Escape can gate this one and still close the bar from its field.
    useHotkey(
        'Escape',
        (e) => {
            if (!open) return;
            e.preventDefault();
            close();
        },
        { enabled: open && !dialogOpen },
    );

    const onQueryChange = useCallback(
        (q: string) => {
            setQuery(q);
            // A new search makes "Replaced N" stale.
            setReplacedCount(null);
            clearTimeout(replacedTimeoutRef.current);
            scheduleSearch(q, options);
        },
        [options, scheduleSearch],
    );

    const toggleMode = useCallback(() => setMode((m) => (m === 'search' ? 'replace' : 'search')), []);
    const togglePreserveCase = useCallback(() => setPreserveCase((p) => !p), []);

    // Side effects, such as this search or step's reveal, stay out of state updater functions.
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

    // The controller is published so the palette's `doc:` scope lists the matches in the document, with
    // revealFromPalette, so a hit opens this bar and reveals its match. usePaletteDocSearch keeps both stable by
    // their shape, so its effect doesn't loop while the app builds a new controller on every render.
    usePaletteDocSearch(controller, commentSearch, { revealFromPalette });

    return (
        <DocSearchBarContext.Provider value={barContext}>
            <div className="relative flex h-full min-h-0 flex-col">
                {/* The content is isolated, so overlays inside it, such as the sheet's cell area layers at z 8 to
                    30, never share a stacking context with the bar. */}
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
