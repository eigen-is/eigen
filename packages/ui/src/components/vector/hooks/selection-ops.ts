// The selection-level write passes every canvas surface shares — the keyboard, the object context menu,
// the properties panel's Arrange row and the clipboard's cut. Each is one sealed undo step over the
// doc writers the host passes in, the way element-writes.ts is plain functions over the doc itself.

import {
    convertToShapes,
    DUPLICATE_OFFSET,
    type NewVectorElement,
    type VectorElement,
    type VectorElementPatch,
    type ZOp,
    zOrderKeys,
} from '@workspace/lib/vector';
import { sealed } from '@workspace/ui/components/properties-panel';
import type * as Y from 'yjs';

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
    const patches = zOrderKeys(elements, selectedIds, op);
    if (!patches.length) return;
    sealed(undoManager, () => updateElements(patches.map((p) => ({ id: p.id, fields: { index: p.index } }))));
}
