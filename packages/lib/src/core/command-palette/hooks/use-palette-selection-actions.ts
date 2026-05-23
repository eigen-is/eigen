import type { PaletteSelectionActions } from '@workspace/lib/types/command-palette';
import { useEffect } from 'react';
import { useCommandPalette } from './use-command-palette';

// Routes call this with the handlers they own — DriveLayout publishes its dialog
// openers, an eigendoc viewer can publish its subset. Mounting registers; unmounting
// clears. Last writer wins, same convention as usePaletteSelection.
export function usePaletteSelectionActions(actions: PaletteSelectionActions): void {
    const { setSelectionActions } = useCommandPalette();
    useEffect(() => {
        setSelectionActions(actions);
        return () => setSelectionActions(null);
    }, [actions, setSelectionActions]);
}
