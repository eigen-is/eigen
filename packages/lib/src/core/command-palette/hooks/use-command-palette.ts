import type { PaletteScope, PaletteSelection, PaletteSelectionActions } from '@workspace/lib/types/command-palette';
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
};

export const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

export function useCommandPalette(): CommandPaletteContextValue {
    const ctx = useContext(CommandPaletteContext);
    if (!ctx) throw new Error('useCommandPalette must be used inside <CommandPaletteProvider>');
    return ctx;
}
