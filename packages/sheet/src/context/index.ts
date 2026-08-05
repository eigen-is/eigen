import React from 'react';
import {
    type Context,
    defaultContext,
    defaultSettings,
    type GlobalCache,
    type PatchOptions,
    type Settings,
} from '../state';

export type RefValues = {
    globalCache: GlobalCache;
    cellInput: React.MutableRefObject<HTMLDivElement | null>;
    fxInput: React.MutableRefObject<HTMLDivElement | null>;
    canvas: React.MutableRefObject<HTMLCanvasElement | null>;
    cellArea: React.MutableRefObject<HTMLDivElement | null>;
    workbookContainer: React.MutableRefObject<HTMLDivElement | null>;
};

export type SetContextOptions = {
    noHistory?: boolean;
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

const WorkbookContext = React.createContext<{
    context: Context;
    setContext: (recipe: (ctx: Context) => void, options?: SetContextOptions) => void;
    settings: Required<Settings>;
    refs: RefValues;
    handleUndo: () => void;
    handleRedo: () => void;
}>({
    context: defaultContext(defaultRefs),
    setContext: () => {},
    settings: defaultSettings,
    handleUndo: () => {},
    handleRedo: () => {},
    refs: defaultRefs,
});

export { WorkbookContext };
