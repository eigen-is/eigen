// Every canvas keyboard command except the layered Escape (that one lives in the canvas because it
// reads live gesture state to cancel an in-progress create/marquee/move) and the z-order brackets
// (shared `useZOrderHotkeys`, which owns the manual event.code listener). Bindings go through
// @tanstack/react-hotkeys (available from packages/ui) mirroring the slides editor's useHotkey +
// enabled-gating discipline, so shortcuts keep working while focus sits off-canvas and auto-ignore
// text inputs.

import { useHotkey } from '@tanstack/react-hotkeys';
import { useYjsUndoHotkeys } from '@workspace/lib/collab';
import { NUDGE_STEP, NUDGE_STEP_LARGE, type VectorElement } from '@workspace/lib/vector';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type * as Y from 'yjs';
import { useZOrderHotkeys, type ZOp } from '../../properties-panel/z-order';
import { applyZOrder, deleteSelection, duplicateSelection } from './selection-ops';
import { holdCapture, type VectorElementPatch } from './use-canvas-doc';
import { VECTOR_TOOLS, type VectorTool } from './use-tool';

type CanvasKeyboardParams = {
    enabled: boolean;
    elements: VectorElement[];
    selectedIds: string[];
    setTool: (t: VectorTool) => void;
    toolLocked: boolean;
    setToolLocked: (locked: boolean) => void;
    setSelection: (ids: string[]) => void;
    undoManager: Y.UndoManager | null;
    deleteElements: (ids: string[]) => void;
    updateElements: (patches: { id: string; fields: VectorElementPatch }[]) => void;
    duplicateElements: (ids: string[], dx: number, dy: number) => string[];
};

// The tools that actually carry keys. A creatable kind the registry gave no shortcut binds nothing
// rather than doubling up on Select's V/1; resolved at module eval, so the hook count and order below
// are fixed across renders.
const KEYED_TOOLS = VECTOR_TOOLS.flatMap(({ tool, shortcut, digit }) =>
    shortcut && digit ? [{ tool, shortcut, digit }] : [],
);

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

// The keys a run of nudges is allowed to contain: the four arrows and the modifiers that qualify them.
const BURST_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Shift', 'Meta', 'Control', 'Alt']);

export const endsNudgeBurst = (key: string): boolean => !BURST_KEYS.has(key);

// A RUN of nudges is one undo step, and leaving the writes unsealed cannot deliver that: Y.UndoManager
// only merges changes landing within `captureTimeout` of each other, and a tap re-renders the whole
// canvas, so two of them routinely land further apart than the 500 ms window and split into a step
// each. The run is a gesture, so it holds the window open like one (the Opacity slider's
// `holdCapture` idiom) — sealed from the op before it when it begins, sealed from whatever follows
// when it ends. `end` is idempotent, so the run can be ended by the input that closes it AND by the
// canvas unmounting under it.
export function createNudgeBurst(undoManager: Y.UndoManager | null): { begin: () => void; end: () => void } {
    let release: (() => void) | null = null;
    return {
        begin: () => {
            release ??= holdCapture(undoManager);
        },
        end: () => {
            release?.();
            release = null;
        },
    };
}

export function useCanvasKeyboard(params: CanvasKeyboardParams) {
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
            KEYED_TOOLS.map(
                ({ tool }) =>
                    () =>
                        live.current.setTool(tool),
            ),
        [],
    );
    for (const [i, { shortcut, digit }] of KEYED_TOOLS.entries()) {
        useHotkey(shortcut, toolHandlers[i], on);
        useHotkey(digit, toolHandlers[i], on);
    }

    // Tool lock — keeps the selected tool active after a placement (Excalidraw's Q padlock).
    const toggleLock = useCallback(() => live.current.setToolLocked(!live.current.toolLocked), []);
    useHotkey('Q', toggleLock, on);

    // A run of nudges holds the undo capture window open (createNudgeBurst) so the whole run is one
    // step. It ends on the first input that is not another nudge — a different key, a pointer press,
    // the window losing focus — and on unmount, so the hold can never outlive this canvas. The
    // listeners sit in the capture phase, ahead of the hotkey handlers, so the op that ends the run
    // is already sealed off from it by the time it writes.
    const burst = useMemo(() => createNudgeBurst(undoManager), [undoManager]);
    const burstRef = useRef(burst);
    burstRef.current = burst;
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (endsNudgeBurst(e.key)) burst.end();
        };
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('pointerdown', burst.end, true);
        window.addEventListener('blur', burst.end);
        return () => {
            document.removeEventListener('keydown', onKeyDown, true);
            document.removeEventListener('pointerdown', burst.end, true);
            window.removeEventListener('blur', burst.end);
            burst.end();
        };
    }, [burst]);

    // Discrete ops go through `sealed` (see deleteSelection/duplicateSelection), so a nudge run that
    // is still open when one fires can't merge into it either way.
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

    // Nudge — 1px, Shift 5px (scene units). One transact per press, all of them inside the run's hold.
    const nudge = useCallback((dx: number, dy: number) => {
        const p = live.current;
        const byId = new Map(p.elements.map((el) => [el.id, el]));
        const patches = p.selectedIds
            .map((id) => byId.get(id))
            .filter((el): el is VectorElement => !!el)
            .map((el) => ({ id: el.id, fields: { x: el.x + dx, y: el.y + dy } }));
        if (!patches.length) return;
        burstRef.current.begin();
        p.updateElements(patches);
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
