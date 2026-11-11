// The canvas's keys, such as the tools, nudges, Delete, ⌘A and ⌘D, Enter and undo. The canvas mounts it and turns it
// off while a text editor, a dialog or a menu owns the keys. Escape stays in the canvas, because it cancels the live
// gesture. The bindings sit on the document, so they work while focus is off the canvas, and skip text inputs.

import { useHotkey } from '@tanstack/react-hotkeys';
import { useYjsUndoHotkeys } from '@workspace/lib/collab';
import { DUPLICATE_HOTKEY, SELECT_ALL_HOTKEY } from '@workspace/lib/constants/hotkeys';
import type { VectorElement, VectorElementPatch, ZOp } from '@workspace/lib/vector';
import { NUDGE_STEP, NUDGE_STEP_LARGE } from '@workspace/lib/vector';
import { holdCapture } from '@workspace/ui/components/properties-panel';
import type { RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type * as Y from 'yjs';
import { useZOrderHotkeys } from '../../properties-panel/z-order';
import { applyZOrder, deleteSelection, duplicateSelection, selectAllElements } from './selection-ops';
import type { VectorTool } from './use-tool';
import { VECTOR_TOOLS } from './use-tool';

type CanvasKeyboardParams = {
    enabled: boolean;
    // An open menu owns the arrows, Delete, letters and Escape. The Edit menu lists ⌘Z and ⇧⌘Z, so undo stays on.
    menuOpen: boolean;
    elements: readonly VectorElement[];
    selectedIds: string[];
    setTool: (t: VectorTool) => void;
    toolLocked: boolean;
    setToolLocked: (locked: boolean) => void;
    setSelection: (ids: string[]) => void;
    undoManager: Y.UndoManager | null;
    deleteElements: (ids: string[]) => void;
    updateElements: (patches: { id: string; fields: VectorElementPatch }[]) => void;
    reorderElements: (ids: string[], selectedIds: string[], op: ZOp) => void;
    duplicateElements: (ids: string[], dx: number, dy: number) => string[];
    onInsertImage?: () => void;
    // The canvas element: Enter edits only when focus is on it or on the page itself, so a focused button,
    // link or rail thumbnail keeps its own Enter.
    containerRef: RefObject<HTMLElement | null>;
    // What a double-click on the sole selected element does, and whether it did anything.
    onEdit: (el: VectorElement) => boolean;
};

// Excalidraw's keys for its image tool and its tool lock; the toolbar shows them beside their rows.
export const INSERT_IMAGE_KEY = '9';
export const TOOL_LOCK_KEY = 'Q';

export function useCanvasKeyboard(params: CanvasKeyboardParams) {
    const { elements, selectedIds, undoManager } = params;
    const enabled = params.enabled && !params.menuOpen;
    const hasSelection = selectedIds.length > 0;

    // Every handler reads the live params through this ref, so a render, such as a drag preview, rebuilds no
    // registration. Only `enabled` changes, in the memoized options.
    const live = useRef(params);
    live.current = params;

    useYjsUndoHotkeys(undoManager, params.enabled);

    const on = useMemo(() => ({ enabled }), [enabled]);
    const onSelection = useMemo(() => ({ enabled: enabled && hasSelection }), [enabled, hasSelection]);
    // A Mod key skips no input by default, so these opt in: ⌘A in a field selects the field's text.
    const onSelectionMod = useMemo(
        () => ({ enabled: enabled && hasSelection, ignoreInputs: true }),
        [enabled, hasSelection],
    );
    const onElementsMod = useMemo(
        () => ({ enabled: enabled && elements.length > 0, ignoreInputs: true }),
        [enabled, elements.length],
    );

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

    const toggleLock = useCallback(() => live.current.setToolLocked(!live.current.toolLocked), []);
    useHotkey(TOOL_LOCK_KEY, toggleLock, on);

    const insertImage = useCallback(() => live.current.onInsertImage?.(), []);
    const canInsertImage = !!params.onInsertImage;
    const onImage = useMemo(() => ({ enabled: enabled && canInsertImage }), [enabled, canInsertImage]);
    useHotkey(INSERT_IMAGE_KEY, insertImage, onImage);

    // The listeners sit in the capture phase, ahead of the hotkey handlers, so the op that ends a run is sealed off
    // from it by the time it writes.
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

    const del = useCallback(() => {
        const p = live.current;
        deleteSelection(p.selectedIds, p.deleteElements, p.setSelection, p.undoManager);
    }, []);
    useHotkey('Delete', del, onSelection);
    useHotkey('Backspace', del, onSelection);

    const selectAll = useCallback((e: KeyboardEvent) => {
        e.preventDefault();
        selectAllElements(live.current.elements, live.current.setSelection);
    }, []);
    useHotkey(SELECT_ALL_HOTKEY, selectAll, onElementsMod);
    const duplicate = useCallback((e: KeyboardEvent) => {
        e.preventDefault();
        const p = live.current;
        duplicateSelection(p.selectedIds, p.duplicateElements, p.setSelection, p.undoManager);
    }, []);
    useHotkey(DUPLICATE_HOTKEY, duplicate, onSelectionMod);

    const edit = useCallback((e: KeyboardEvent) => {
        const p = live.current;
        if (e.target !== document.body && e.target !== p.containerRef.current) return;
        const el =
            p.selectedIds.length === 1 ? p.elements.find((candidate) => candidate.id === p.selectedIds[0]) : null;
        if (el && p.onEdit(el)) e.preventDefault();
    }, []);
    // The library takes every key it matches, a focused button's Enter too. This handler decides, so it asks
    // for neither.
    const onEnter = useMemo(
        () => ({ enabled: enabled && hasSelection, preventDefault: false, stopPropagation: false }),
        [enabled, hasSelection],
    );
    useHotkey('Enter', edit, onEnter);

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

    const arrange = useCallback((op: ZOp) => {
        const p = live.current;
        applyZOrder(op, p.elements, p.selectedIds, p.reorderElements, p.undoManager);
    }, []);
    useZOrderHotkeys(enabled && hasSelection, arrange);
}

// A module constant, so the hook binds the same keys in the same order on every render.
const KEYED_TOOLS = VECTOR_TOOLS.flatMap(({ tool, shortcut, digit }) =>
    shortcut && digit ? [{ tool, shortcut, digit }] : [],
);

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

const BURST_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Shift', 'Meta', 'Control', 'Alt']);

export const endsNudgeBurst = (key: string): boolean => !BURST_KEYS.has(key);

// A run of nudges is one undo step. Two taps often land further apart than the undo manager's 500 ms window, so the
// run holds the window open as a gesture does. `end` may run twice: the input that ends the run and an unmount.
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
