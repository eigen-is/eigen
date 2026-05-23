import { CommandPaletteContext } from '@workspace/lib/command-palette';
import type { CommandPaletteContextValue } from '@workspace/lib/command-palette/hooks/use-command-palette';
import type { PaletteScope, PaletteSelection } from '@workspace/lib/types/command-palette';
import { type ReactNode, useMemo, useState } from 'react';

type Props = { children: ReactNode };

export function CommandPaletteProvider({ children }: Props) {
    const [open, setOpen] = useState(false);
    const [input, setInput] = useState('');
    const [scope, setScope] = useState<PaletteScope | undefined>(undefined);
    const [selection, setSelection] = useState<PaletteSelection>(null);

    const value = useMemo<CommandPaletteContextValue>(
        () => ({ open, setOpen, input, setInput, scope, setScope, selection, setSelection }),
        [open, input, scope, selection],
    );

    return <CommandPaletteContext.Provider value={value}>{children}</CommandPaletteContext.Provider>;
}
