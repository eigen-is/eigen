// The React context the Workbook provides to every part of the grid: the workbook it renders, the way to write it, the
// DOM refs and the host's hooks, undo and redo, and the paste a menu row runs. `context` is the workbook as it was last
// rendered. A read that must see a write made since that render, such as one right after an edit, goes through
// `getContext()`. A host render changes none of this, so the parts behind a memo stay as they are.

import React from 'react';
import type { Context, GlobalCache, PatchOptions, RefValues } from '../state';
import { defaultContext } from '../state';

export type SetContextOptions = {
    // Skip patch generation entirely: no op emitted to peers AND no undo entry.
    noHistory?: boolean;
    // Emit the op but record no undo entry, so a technical fixup (such as a paste height correction) stays one ⌘Z.
    // Unlike noHistory, peers still get the op.
    noUndo?: boolean;
} & PatchOptions;

const defaultGlobalCache: GlobalCache = {
    undoList: [],
    redoList: [],
    scrollLeft: 0,
    scrollTop: 0,
    scrollListeners: new Set(),
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
