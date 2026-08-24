// Every canvas keyboard command except the layered Escape (that one lives in the canvas because it
// reads live gesture state to cancel an in-progress create/marquee/move) and the z-order brackets
// (shared `useZOrderHotkeys`, which owns the manual event.code listener). Bindings go through
// @tanstack/react-hotkeys (available from packages/ui) mirroring the slides editor's useHotkey +
// enabled-gating discipline, so shortcuts keep working while focus sits off-canvas and auto-ignore
// text inputs.

import { useHotkey } from '@tanstack/react-hotkeys';
import { useYjsUndoHotkeys } from '@workspace/lib/collab';
import { generateNKeysBetween, orderByFractionalIndex, type VectorElement } from '@workspace/lib/vector';
import type * as Y from 'yjs';
import { useZOrderHotkeys, type ZOp } from '../../properties-panel/z-order';
import type { VectorTool } from './use-tool';
import type { VectorElementPatch } from './use-vector-doc';

const NUDGE = 1;
const NUDGE_LARGE = 5;
const DUPLICATE_OFFSET = 10;

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
    setSelection: (ids: string[]) => void;
    undoManager: Y.UndoManager | null;
    deleteElements: (ids: string[]) => void;
    updateElements: (patches: { id: string; fields: VectorElementPatch }[]) => void;
    duplicateElements: (ids: string[], dx: number, dy: number) => string[];
};

export function useVectorKeyboard(params: VectorKeyboardParams) {
    const { enabled, elements, selectedIds, setTool, setSelection, undoManager } = params;
    const { deleteElements, updateElements, duplicateElements } = params;
    const hasSelection = selectedIds.length > 0;

    // Undo/redo through the doc's own UndoManager (⌘Z / ⌘⇧Z / ⌘Y).
    useYjsUndoHotkeys(undoManager, enabled);

    // Tools — single keys, so the lib's ignoreInputs default keeps them off while typing elsewhere.
    useHotkey('V', () => setTool('select'), { enabled });
    useHotkey('1', () => setTool('select'), { enabled });
    useHotkey('R', () => setTool('rectangle'), { enabled });
    useHotkey('2', () => setTool('rectangle'), { enabled });
    useHotkey('D', () => setTool('diamond'), { enabled });
    useHotkey('3', () => setTool('diamond'), { enabled });
    useHotkey('O', () => setTool('ellipse'), { enabled });
    useHotkey('4', () => setTool('ellipse'), { enabled });
    useHotkey('T', () => setTool('text'), { enabled });
    useHotkey('8', () => setTool('text'), { enabled });

    // Discrete ops seal the undo group on BOTH sides: stopCapturing before opens a fresh step,
    // stopCapturing after keeps a nudge inside the 500ms capture window from merging into it.
    // Nudges themselves carry neither, so rapid taps still coalesce.
    const del = () => {
        undoManager?.stopCapturing();
        deleteElements(selectedIds);
        undoManager?.stopCapturing();
        setSelection([]);
    };
    useHotkey('Delete', del, { enabled: enabled && hasSelection });
    useHotkey('Backspace', del, { enabled: enabled && hasSelection });

    // Mod combos default ignoreInputs off, so opt in — ⌘A must not hijack select-all in an input.
    useHotkey(
        'Mod+A',
        (e) => {
            e.preventDefault();
            setSelection(elements.map((el) => el.id));
        },
        { enabled: enabled && elements.length > 0, ignoreInputs: true },
    );
    useHotkey(
        'Mod+D',
        (e) => {
            e.preventDefault();
            undoManager?.stopCapturing();
            const ids = duplicateElements(selectedIds, DUPLICATE_OFFSET, DUPLICATE_OFFSET);
            undoManager?.stopCapturing();
            if (ids.length) setSelection(ids);
        },
        { enabled: enabled && hasSelection, ignoreInputs: true },
    );

    // Nudge — 1px, Shift 5px (scene units). One transact per press (undo coalesces rapid taps).
    const nudge = (dx: number, dy: number) => {
        const byId = new Map(elements.map((el) => [el.id, el]));
        const patches = selectedIds
            .map((id) => byId.get(id))
            .filter((el): el is VectorElement => !!el)
            .map((el) => ({ id: el.id, fields: { x: el.x + dx, y: el.y + dy } }));
        if (patches.length) updateElements(patches);
    };
    const arrow = (dx: number, dy: number) => (e: KeyboardEvent) => {
        e.preventDefault();
        nudge(dx, dy);
    };
    const nudgeEnabled = { enabled: enabled && hasSelection };
    useHotkey('ArrowLeft', arrow(-NUDGE, 0), nudgeEnabled);
    useHotkey('ArrowRight', arrow(NUDGE, 0), nudgeEnabled);
    useHotkey('ArrowUp', arrow(0, -NUDGE), nudgeEnabled);
    useHotkey('ArrowDown', arrow(0, NUDGE), nudgeEnabled);
    useHotkey('Shift+ArrowLeft', arrow(-NUDGE_LARGE, 0), nudgeEnabled);
    useHotkey('Shift+ArrowRight', arrow(NUDGE_LARGE, 0), nudgeEnabled);
    useHotkey('Shift+ArrowUp', arrow(0, -NUDGE_LARGE), nudgeEnabled);
    useHotkey('Shift+ArrowDown', arrow(0, NUDGE_LARGE), nudgeEnabled);

    // Z-order: ⌘[/⌘] step, ⌘⇧[/⌘⇧] to back/front — shared hook owns the manual event.code listener,
    // fed vector's fractional-index write.
    useZOrderHotkeys(enabled && hasSelection, (op) =>
        applyZOrder(op, elements, selectedIds, updateElements, undoManager),
    );
}
