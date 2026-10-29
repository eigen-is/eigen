// The React context the Workbook provides to every part of the grid: the workbook it renders, the way to write it, the
// settings, the DOM refs and undo and redo. A component renders from `context` and reads `getContext()` in an event
// handler, which also sees a write made since the last render.

import React from 'react';
import type { Context, GlobalCache, PatchOptions, Settings } from '../state';
import { defaultContext, defaultSettings } from '../state';

export type RefValues = {
    globalCache: GlobalCache;
    cellInput: React.MutableRefObject<HTMLDivElement | null>;
    fxInput: React.MutableRefObject<HTMLDivElement | null>;
    canvas: React.MutableRefObject<HTMLCanvasElement | null>;
    cellArea: React.MutableRefObject<HTMLDivElement | null>;
    workbookContainer: React.MutableRefObject<HTMLDivElement | null>;
};

export type SetContextOptions = {
    // Skip patch generation entirely: no op emitted to peers AND no undo entry.
    noHistory?: boolean;
    // Emit the collaborative op but record NO local undo entry. For technical fixups a user never
    // undoes as their own step — the pending→real image mediaName swap and the paste-flow height
    // correction — so a single paste stays one ⌘Z. Distinct from noHistory, which skips op emission too.
    noUndo?: boolean;
    logPatch?: boolean;
} & PatchOptions;

const defaultScrollListeners = new Set<() => void>();
const defaultGlobalCache: GlobalCache = {
    undoList: [],
    redoList: [],
    scrollLeft: 0,
    scrollTop: 0,
    scrollListeners: defaultScrollListeners,
    notifyScrollListeners: () => {
        for (const fn of defaultScrollListeners) {
            fn();
        }
    },
};

const defaultRefs: RefValues = {
    globalCache: defaultGlobalCache,
    cellInput: React.createRef<HTMLDivElement | null>(),
    fxInput: React.createRef<HTMLDivElement | null>(),
    canvas: React.createRef<HTMLCanvasElement | null>(),
    cellArea: React.createRef<HTMLDivElement | null>(),
    workbookContainer: React.createRef<HTMLDivElement | null>(),
};

const defaultWorkbook = defaultContext(defaultRefs);

const WorkbookContext = React.createContext<{
    context: Context;
    getContext: () => Context;
    setContext: (recipe: (ctx: Context) => void, options?: SetContextOptions) => void;
    settings: Required<Settings>;
    refs: RefValues;
    handleUndo: () => void;
    handleRedo: () => void;
}>({
    context: defaultWorkbook,
    getContext: () => defaultWorkbook,
    setContext: () => {},
    settings: defaultSettings,
    handleUndo: () => {},
    handleRedo: () => {},
    refs: defaultRefs,
});

export { WorkbookContext };
