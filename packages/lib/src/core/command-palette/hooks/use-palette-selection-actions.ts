import type { PaletteSelectionActions } from '@workspace/lib/types/command-palette';
import { useEffect, useMemo, useRef } from 'react';
import { useCommandPalette } from './use-command-palette';

// Routes publish a bag of selection-aware handlers (DriveLayout publishes its dialog
// openers, an eigendoc viewer can publish its subset). The published bag's identity
// must stay stable for the lifetime of the publisher — otherwise the publication
// effect would refire on every render, the context update would re-render the
// publisher (via useCommandPalette), and the cycle would trip React's max-update
// guard. Most publishers can't realistically guarantee stable identity (any handler
// that depends on an unstable route prop poisons the chain), so the hook itself
// stabilises: every wrapped handler routes through a ref to the latest implementation,
// and the wrapper's identity only changes when the SHAPE — which handler keys are
// present — changes.
export function usePaletteSelectionActions(actions: PaletteSelectionActions): void {
    const { setSelectionActions } = useCommandPalette();

    const actionsRef = useRef<PaletteSelectionActions>(actions);
    actionsRef.current = actions;

    // Shape key: a stable string for the set of present handler keys. Driven by
    // booleans, not by handler identities — so it doesn't churn on each render.
    const shapeKey = actions
        ? [
              actions.onDownload ? 'D' : '_',
              actions.onRename ? 'R' : '_',
              actions.onShare ? 'S' : '_',
              actions.onEmailCollaborators ? 'E' : '_',
              actions.onDelete ? 'X' : '_',
          ].join('')
        : null;

    const stableActions = useMemo<PaletteSelectionActions>(() => {
        if (!shapeKey || !actions) return null;
        const wrapped: NonNullable<PaletteSelectionActions> = {};
        if (actions.onDownload) wrapped.onDownload = (item) => actionsRef.current?.onDownload?.(item);
        if (actions.onRename) wrapped.onRename = (item) => actionsRef.current?.onRename?.(item);
        if (actions.onShare) wrapped.onShare = (item) => actionsRef.current?.onShare?.(item);
        if (actions.onEmailCollaborators) {
            wrapped.onEmailCollaborators = (item) => actionsRef.current?.onEmailCollaborators?.(item);
        }
        if (actions.onDelete) wrapped.onDelete = (items) => actionsRef.current?.onDelete?.(items);
        return wrapped;
        // shapeKey is the meaningful trigger; actions identity is intentionally not a dep
        // because the wrappers route through actionsRef and don't capture the closure.
    }, [shapeKey]);

    useEffect(() => {
        setSelectionActions(stableActions);
        return () => setSelectionActions(null);
    }, [stableActions, setSelectionActions]);
}
