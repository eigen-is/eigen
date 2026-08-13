import { CommandPaletteContext, type CommandPaletteContextValue } from '@workspace/lib/command-palette';
import type { PaletteScope, PaletteSelection, PaletteSelectionActions } from '@workspace/lib/types/command-palette';
import type { DocCommentSearch, DocSearchController, DocSearchSession } from '@workspace/lib/types/doc-search';
import { type ReactNode, useMemo, useState } from 'react';

type Props = { children: ReactNode };

export function CommandPaletteProvider({ children }: Props) {
    const [open, setOpen] = useState(false);
    const [input, setInput] = useState('');
    const [scope, setScope] = useState<PaletteScope | undefined>(undefined);
    const [selection, setSelection] = useState<PaletteSelection>(null);
    const [selectionActions, setSelectionActions] = useState<PaletteSelectionActions>(null);
    const [docSearch, setDocSearch] = useState<DocSearchController | null>(null);
    const [docSearchSession, setDocSearchSession] = useState<DocSearchSession | null>(null);
    const [docCommentSearch, setDocCommentSearch] = useState<DocCommentSearch>(null);

    const value = useMemo<CommandPaletteContextValue>(
        () => ({
            open,
            setOpen,
            input,
            setInput,
            scope,
            setScope,
            selection,
            setSelection,
            selectionActions,
            setSelectionActions,
            docSearch,
            setDocSearch,
            docSearchSession,
            setDocSearchSession,
            docCommentSearch,
            setDocCommentSearch,
        }),
        [open, input, scope, selection, selectionActions, docSearch, docSearchSession, docCommentSearch],
    );

    return <CommandPaletteContext.Provider value={value}>{children}</CommandPaletteContext.Provider>;
}
