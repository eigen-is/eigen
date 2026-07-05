import type { PaletteScope, PaletteSelection, PaletteSelectionActions } from '@workspace/lib/types/command-palette';
import type { DocSearchController } from '@workspace/lib/types/doc-search';
import type { Dispatch, SetStateAction } from 'react';
import { createContext, useContext } from 'react';

export type CommandPaletteContextValue = {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    input: string;
    setInput: Dispatch<SetStateAction<string>>;
    scope: PaletteScope | undefined;
    setScope: Dispatch<SetStateAction<PaletteScope | undefined>>;
    selection: PaletteSelection;
    setSelection: Dispatch<SetStateAction<PaletteSelection>>;
    selectionActions: PaletteSelectionActions;
    setSelectionActions: Dispatch<SetStateAction<PaletteSelectionActions>>;
    docSearch: DocSearchController | null;
    setDocSearch: Dispatch<SetStateAction<DocSearchController | null>>;
};

export const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

export function useCommandPalette(): CommandPaletteContextValue {
    const ctx = useContext(CommandPaletteContext);
    if (!ctx) throw new Error('useCommandPalette must be used inside <CommandPaletteProvider>');
    return ctx;
}

// Returns null when no provider is in the tree, for callers that want to render
// nothing in that case (e.g. AppShell when used by the marketing-only index app
// which doesn't mount the full EigenApp provider stack).
export function useOptionalCommandPalette(): CommandPaletteContextValue | null {
    return useContext(CommandPaletteContext);
}
