import type { PaletteSelection } from '@workspace/lib/types/command-palette';
import type { DrivePath } from '@workspace/lib/types/drive';
import { useEffect, useMemo } from 'react';
import { useCommandPalette } from './use-command-palette';

// Apps publish their current selection (or null to clear). Mounting publishes;
// unmounting (or value change to null) clears. Last writer wins, same as the preview
// provider. The hook stabilises the published value so callers don't have to memoise
// the wrapper themselves: identity only changes when the set of item ids changes —
// which is the only thing the palette catalog actually cares about. Without this,
// callers like `usePaletteSelection({ items })` would inadvertently trip the
// publication-effect → context-update → re-render loop.
export function usePaletteSelection(selection: PaletteSelection): void {
    const { setSelection } = useCommandPalette();

    const idsKey = selection ? selection.items.map((i) => i.id).join('|') : null;

    const stable = useMemo<PaletteSelection>(() => {
        if (!selection) return null;
        return { items: selection.items };
        // idsKey is the meaningful trigger; selection identity is intentionally not a dep —
        // we re-wrap only when the set of ids changes.
    }, [idsKey]);

    useEffect(() => {
        setSelection(stable);
        return () => setSelection(null);
    }, [stable, setSelection]);
}

// Convenience wrapper for the four eigendoc viewer routes (docs/sheets/slides/stickies):
// publishes the currently-open document as a single-item palette selection so
// item-aware commands (Mail to…, Copy link, Quick preview, …) surface from the viewer.
// Saves each viewer from repeating the same useMemo + usePaletteSelection pair.
export function usePaletteDocSelection(path: DrivePath | null | undefined): void {
    const selection = useMemo<PaletteSelection>(() => (path ? { items: [path] } : null), [path]);
    usePaletteSelection(selection);
}
