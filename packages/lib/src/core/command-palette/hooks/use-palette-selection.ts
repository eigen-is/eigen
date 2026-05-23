import type { PaletteSelection } from '@workspace/lib/types/command-palette';
import { useEffect } from 'react';
import { useCommandPalette } from './use-command-palette';

// Apps call this hook with their current selection (or null to clear). Mounting
// publishes; unmounting (or value change to null) clears. Last writer wins, same as
// the preview provider.
export function usePaletteSelection(selection: PaletteSelection): void {
    const { setSelection } = useCommandPalette();
    useEffect(() => {
        setSelection(selection);
        return () => setSelection(null);
    }, [selection, setSelection]);
}
