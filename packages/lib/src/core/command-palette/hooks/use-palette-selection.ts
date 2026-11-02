// A page hands the command palette what is selected and the rows it can run on it, such as a Drive
// listing's selected items with their menu's actions, or an open document with its File menu's. The
// palette's Selection section is built from what is published here. Mounting publishes, unmounting
// clears, and the last publisher wins.

import type { PaletteSelectionAction, PaletteSelectionActions } from '@workspace/lib/types/command-palette';
import type { DrivePath } from '@workspace/lib/types/drive';
import { useEffect, useMemo, useRef } from 'react';
import { useCommandPalette } from './use-command-palette';

// Publishing updates the palette's context, which re-renders the publisher. A new identity on every
// render would publish again and loop React into its update limit, and one row built from an unstable
// prop is enough for that. So the hook stabilises what it publishes: the identity changes only when
// the item ids or the rows' ids and labels do, and each published run calls the latest one through a ref.
export function usePaletteSelection(items: DrivePath[], actions: readonly PaletteSelectionAction[]): void {
    const { setSelection, setSelectionActions } = useCommandPalette();

    const latest = useRef(actions);
    latest.current = actions;

    const ids = items.map((item) => item.id).join('|');
    const rows = actions.map(({ action }) => `${action.id}:${action.label}`).join('|');

    const published = useMemo(() => {
        if (items.length === 0) return { selection: null, actions: null };
        const stable: PaletteSelectionActions = actions.map(({ action }, index) => ({
            action,
            run: (format) => latest.current[index]?.run(format),
        }));
        return { selection: { items }, actions: stable };
        // The keys are the meaningful trigger: a re-render with the same items and rows keeps the
        // published identity, and the runs reach the latest closures through the ref.
    }, [ids, rows]);

    useEffect(() => {
        setSelection(published.selection);
        setSelectionActions(published.actions);
        return () => {
            setSelection(null);
            setSelectionActions(null);
        };
    }, [published, setSelection, setSelectionActions]);
}
