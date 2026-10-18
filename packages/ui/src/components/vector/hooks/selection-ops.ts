// The selection-level write passes every canvas surface shares — the keyboard, the object context menu,
// the properties panel's Arrange row and the clipboard's cut. Each is one sealed undo step over the
// doc writers the host passes in, the way element-writes.ts is plain functions over the doc itself.

import {
    convertToShapes,
    DUPLICATE_OFFSET,
    generateNKeysBetween,
    type NewVectorElement,
    orderByFractionalIndex,
    type VectorElement,
    type VectorElementPatch,
} from '@workspace/lib/vector';
import { sealed } from '@workspace/ui/components/properties-panel';
import type * as Y from 'yjs';
import type { ZOp } from '../../properties-panel/z-order';

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
// one sealed undo step, and reselects the new copies.
export function duplicateSelection(
    selectedIds: string[],
    duplicateElements: (ids: string[], dx: number, dy: number) => string[],
    setSelection: (ids: string[]) => void,
    undoManager: Y.UndoManager | null,
): void {
    const ids = sealed(undoManager, () => duplicateElements(selectedIds, DUPLICATE_OFFSET, DUPLICATE_OFFSET));
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
    sealed(undoManager, () => deleteElements(selectedIds));
    setSelection([]);
}

// What Convert to shapes writes for the selection: offered only for exactly one element that unpacks, a
// chart that draws; [] for anything else.
export function selectionShapes(selectedIds: string[], byId: Map<string, VectorElement>): VectorElement[] {
    const only = selectedIds.length === 1 ? byId.get(selectedIds[0]) : undefined;
    return only ? convertToShapes(only) : [];
}

// Convert to shapes (the object menu; the chart panel's button): one sealed undo step, and the new elements
// stay selected, as the one object was (T4-R3).
export function convertElementToShapes(
    id: string,
    shapes: NewVectorElement[],
    replaceElement: (id: string, partials: NewVectorElement[]) => string[],
    setSelection: (ids: string[]) => void,
    undoManager: Y.UndoManager | null,
): void {
    const ids = sealed(undoManager, () => replaceElement(id, shapes));
    if (ids.length) setSelection(ids);
}

// The z-order write, shared by the keyboard brackets and the properties panel's Arrange buttons so
// the fractional-index math lives in one place. One sealed undo step, and a no-op when the block is
// already at the edge.
export function applyZOrder(
    op: ZOp,
    elements: VectorElement[],
    selectedIds: string[],
    updateElements: (patches: { id: string; fields: VectorElementPatch }[]) => void,
    undoManager: Y.UndoManager | null,
): void {
    const patches = computeZOrder(orderByFractionalIndex(elements), selectedIds, op);
    if (!patches.length) return;
    sealed(undoManager, () => updateElements(patches.map((p) => ({ id: p.id, fields: { index: p.index } }))));
}
