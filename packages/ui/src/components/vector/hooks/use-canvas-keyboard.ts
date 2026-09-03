// Every canvas keyboard command except the layered Escape (that one lives in the canvas because it
// reads live gesture state to cancel an in-progress create/marquee/move) and the z-order brackets
// (shared `useZOrderHotkeys`, which owns the manual event.code listener). Bindings go through
// @tanstack/react-hotkeys (available from packages/ui) mirroring the slides editor's useHotkey +
// enabled-gating discipline, so shortcuts keep working while focus sits off-canvas and auto-ignore
// text inputs.

import { useHotkey } from '@tanstack/react-hotkeys';
import { useYjsUndoHotkeys } from '@workspace/lib/collab';
import {
    DUPLICATE_OFFSET,
    generateNKeysBetween,
    NUDGE_STEP,
    NUDGE_STEP_LARGE,
    orderByFractionalIndex,
    type VectorElement,
} from '@workspace/lib/vector';
import { useCallback, useMemo, useRef } from 'react';
import type * as Y from 'yjs';
import { useZOrderHotkeys, type ZOp } from '../../properties-panel/z-order';
import type { VectorElementPatch } from './use-canvas-doc';
import { VECTOR_TOOLS, type VectorTool } from './use-tool';

// Fractional-index rewrites for a z-order change. The selection moves as a block relative to the
// NON-selected elements, so a non-contiguous multi-selection collapses into one clean gap
// (Excalidraw's raise/lower semantics); for a single element this reduces to a one-step swap.
// Returns {id, index} per moved element, or [] for a no-op.
function computeZOrder(ordered: VectorElement[], selectedIds: string[], op: ZOp): { id: string; index: string }[] {
    const sel = ordered.filter((e) => selectedIds.includes(e.id));
    const nonSel = ordered.filter((e) => !selectedIds.includes(e.id));
    if (sel.length === 0) return [];

    let keys: string[];
    if (op === 'toFront') {
        keys = generateNKeysBetween(nonSel[nonSel.length - 1]?.index ?? null, null, sel.length);
    } else if (op === 'toBack') {
        keys = generateNKeysBetween(null, nonSel[0]?.index ?? null, sel.length);
    } else if (op === 'forward') {
        if (nonSel.length === 0) return [];
        const topPos = ordered.indexOf(sel[sel.length - 1]);
        const above = ordered.slice(topPos + 1).find((e) => !selectedIds.includes(e.id));
        if (!above) return []; // block already above every non-selected element
        const aboveInNon = nonSel.indexOf(above);
        keys = generateNKeysBetween(above.index, nonSel[aboveInNon + 1]?.index ?? null, sel.length);
    } else {
        if (nonSel.length === 0) return [];
        const bottomPos = ordered.indexOf(sel[0]);
        const below = ordered
            .slice(0, bottomPos)
            .reverse()
            .find((e) => !selectedIds.includes(e.id));
        if (!below) return []; // block already below every non-selected element
        const belowInNon = nonSel.indexOf(below);
        keys = generateNKeysBetween(nonSel[belowInNon - 1]?.index ?? null, below.index, sel.length);
    }
    return sel.map((e, i) => ({ id: e.id, index: keys[i] }));
}

// Duplicate the selection (⌘D and the object context menu share this) — offsets each copy by +10,+10,
// seals the undo group on both sides so it's one step, and reselects the new copies.
export function duplicateSelection(
    selectedIds: string[],
    duplicateElements: (ids: string[], dx: number, dy: number) => string[],
    setSelection: (ids: string[]) => void,
    undoManager: Y.UndoManager | null,
): void {
    undoManager?.stopCapturing();
    const ids = duplicateElements(selectedIds, DUPLICATE_OFFSET, DUPLICATE_OFFSET);
    undoManager?.stopCapturing();
    if (ids.length) setSelection(ids);
}

// Delete the selection (Delete/Backspace and the object context menu share this) — one sealed undo
// step, then clears the selection.
export function deleteSelection(
    selectedIds: string[],
    deleteElements: (ids: string[]) => void,
    setSelection: (ids: string[]) => void,
    undoManager: Y.UndoManager | null,
): void {
    undoManager?.stopCapturing();
    deleteElements(selectedIds);
    undoManager?.stopCapturing();
    setSelection([]);
}

// The z-order write, shared by the keyboard brackets and the properties panel's Arrange buttons so
// the fractional-index math lives in one place. Seals the undo group on both sides (one step) and
// no-ops when the block is already at the edge.
export function applyZOrder(
    op: ZOp,
    elements: VectorElement[],
    selectedIds: string[],
    updateElements: (patches: { id: string; fields: VectorElementPatch }[]) => void,
    undoManager: Y.UndoManager | null,
): void {
    const patches = computeZOrder(orderByFractionalIndex(elements), selectedIds, op);
    if (!patches.length) return;
    undoManager?.stopCapturing();
    updateElements(patches.map((p) => ({ id: p.id, fields: { index: p.index } })));
    undoManager?.stopCapturing();
}

type VectorKeyboardParams = {
    enabled: boolean;
    elements: VectorElement[];
    selectedIds: string[];
    tool: VectorTool;
    setTool: (t: VectorTool) => void;
    toolLocked: boolean;
    setToolLocked: (locked: boolean) => void;
    setSelection: (ids: string[]) => void;
    undoManager: Y.UndoManager | null;
    deleteElements: (ids: string[]) => void;
    updateElements: (patches: { id: string; fields: VectorElementPatch }[]) => void;
    duplicateElements: (ids: string[], dx: number, dy: number) => string[];
};

// The nudge bindings in one table, so the eight handlers are built — and memoized — in one place.
const NUDGES = [
    ['ArrowLeft', -NUDGE_STEP, 0],
    ['ArrowRight', NUDGE_STEP, 0],
    ['ArrowUp', 0, -NUDGE_STEP],
    ['ArrowDown', 0, NUDGE_STEP],
    ['Shift+ArrowLeft', -NUDGE_STEP_LARGE, 0],
    ['Shift+ArrowRight', NUDGE_STEP_LARGE, 0],
    ['Shift+ArrowUp', 0, -NUDGE_STEP_LARGE],
    ['Shift+ArrowDown', 0, NUDGE_STEP_LARGE],
] as const;

export function useCanvasKeyboard(params: VectorKeyboardParams) {
    const { enabled, elements, selectedIds, undoManager } = params;
    const hasSelection = selectedIds.length > 0;

    // Every handler below reads the live params through this ref, so all 34 registrations keep ONE
    // identity for the canvas' lifetime: a render (a drag preview, a selection change) allocates no
    // callbacks and rebuilds no registration. Only `enabled` may change, in the memoized options.
    const live = useRef(params);
    live.current = params;

    // Undo/redo through the doc's own UndoManager (⌘Z / ⌘⇧Z / ⌘Y).
    useYjsUndoHotkeys(undoManager, enabled);

    const on = useMemo(() => ({ enabled }), [enabled]);
    const onSelection = useMemo(() => ({ enabled: enabled && hasSelection }), [enabled, hasSelection]);
    const onSelectionMod = useMemo(
        () => ({ enabled: enabled && hasSelection, ignoreInputs: true }),
        [enabled, hasSelection],
    );
    const onElementsMod = useMemo(
        () => ({ enabled: enabled && elements.length > 0, ignoreInputs: true }),
        [enabled, elements.length],
    );

    // Tools — single keys, so the lib's ignoreInputs default keeps them off while typing elsewhere. The
    // letter and the digit come from VECTOR_TOOLS, the one table the toolbar reads, so a new tool binds
    // itself. A module constant, so the hook count and order are fixed across renders.
    const toolHandlers = useMemo(
        () =>
            VECTOR_TOOLS.map(
                ({ tool }) =>
                    () =>
                        live.current.setTool(tool),
            ),
        [],
    );
    for (const [i, { shortcut, digit }] of VECTOR_TOOLS.entries()) {
        useHotkey(shortcut, toolHandlers[i], on);
        useHotkey(digit, toolHandlers[i], on);
    }

    // Tool lock — keeps the selected tool active after a placement (Excalidraw's Q padlock).
    const toggleLock = useCallback(() => live.current.setToolLocked(!live.current.toolLocked), []);
    useHotkey('Q', toggleLock, on);

    // Discrete ops seal the undo group on BOTH sides (see deleteSelection/duplicateSelection): a
    // nudge inside the 500ms capture window then can't merge into them. Nudges themselves carry no
    // seal, so rapid taps still coalesce.
    const del = useCallback(() => {
        const p = live.current;
        deleteSelection(p.selectedIds, p.deleteElements, p.setSelection, p.undoManager);
    }, []);
    useHotkey('Delete', del, onSelection);
    useHotkey('Backspace', del, onSelection);

    // Mod combos default ignoreInputs off, so opt in — ⌘A must not hijack select-all in an input.
    const selectAll = useCallback((e: KeyboardEvent) => {
        e.preventDefault();
        const p = live.current;
        p.setSelection(p.elements.map((el) => el.id));
    }, []);
    useHotkey('Mod+A', selectAll, onElementsMod);
    const duplicate = useCallback((e: KeyboardEvent) => {
        e.preventDefault();
        const p = live.current;
        duplicateSelection(p.selectedIds, p.duplicateElements, p.setSelection, p.undoManager);
    }, []);
    useHotkey('Mod+D', duplicate, onSelectionMod);

    // Nudge — 1px, Shift 5px (scene units). One transact per press (undo coalesces rapid taps).
    const nudge = useCallback((dx: number, dy: number) => {
        const p = live.current;
        const byId = new Map(p.elements.map((el) => [el.id, el]));
        const patches = p.selectedIds
            .map((id) => byId.get(id))
            .filter((el): el is VectorElement => !!el)
            .map((el) => ({ id: el.id, fields: { x: el.x + dx, y: el.y + dy } }));
        if (patches.length) p.updateElements(patches);
    }, []);
    const nudgeHandlers = useMemo(
        () =>
            NUDGES.map(([, dx, dy]) => (e: KeyboardEvent) => {
                e.preventDefault();
                nudge(dx, dy);
            }),
        [nudge],
    );
    for (const [i, [key]] of NUDGES.entries()) useHotkey(key, nudgeHandlers[i], onSelection);

    // Z-order: ⌘[/⌘] step, ⌘⇧[/⌘⇧] to back/front — shared hook owns the manual event.code listener,
    // fed vector's fractional-index write.
    const arrange = useCallback((op: ZOp) => {
        const p = live.current;
        applyZOrder(op, p.elements, p.selectedIds, p.updateElements, p.undoManager);
    }, []);
    useZOrderHotkeys(enabled && hasSelection, arrange);
}
