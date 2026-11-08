// The React context the Workbook provides to every part of the grid: the workbook it renders, the way to write it, the
// DOM refs and the host's hooks, undo and redo, and the paste a menu row runs. `context` is the workbook as it was last
// rendered. A read that must see a write made since that render, such as one right after an edit, goes through
// `getContext()`. A host render changes none of this, so the parts behind a memo stay as they are.

import React from 'react';
import type { Context, GlobalCache, Hooks, PatchOptions } from '../state';
import { defaultContext } from '../state';

export type RefValues = {
    globalCache: GlobalCache;
    cellInput: React.MutableRefObject<HTMLDivElement | null>;
    fxInput: React.MutableRefObject<HTMLDivElement | null>;
    canvas: React.MutableRefObject<HTMLCanvasElement | null>;
    cellArea: React.MutableRefObject<HTMLDivElement | null>;
    workbookContainer: React.MutableRefObject<HTMLDivElement | null>;
    hooks: React.MutableRefObject<Hooks>;
};

export type SetContextOptions = {
    // Skip patch generation entirely: no op emitted to peers AND no undo entry.
    noHistory?: boolean;
    // Emit the collaborative op but record NO local undo entry. For technical fixups a user never
    // undoes as their own step — the pending→real image mediaName swap and the paste-flow height
    // correction — so a single paste stays one ⌘Z. Distinct from noHistory, which skips op emission too.
    noUndo?: boolean;
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
    hooks: { current: {} },
};

const defaultWorkbook = defaultContext(defaultRefs);

const WorkbookContext = React.createContext<{
    context: Context;
    getContext: () => Context;
    setContext: (recipe: (ctx: Context) => void, options?: SetContextOptions) => void;
    aspectLocked: boolean;
    refs: RefValues;
    handleUndo: () => void;
    handleRedo: () => void;
    pasteClipboard: (clipboardData: DataTransfer) => void;
}>({
    context: defaultWorkbook,
    getContext: () => defaultWorkbook,
    setContext: () => {},
    aspectLocked: false,
    handleUndo: () => {},
    handleRedo: () => {},
    pasteClipboard: () => {},
    refs: defaultRefs,
});

export { WorkbookContext };
