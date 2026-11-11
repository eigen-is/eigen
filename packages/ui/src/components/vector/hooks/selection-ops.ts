// The selection-level passes every canvas surface shares, such as the keyboard, the menus and the properties panel's
// Arrange row, so a key and its menu row do the same thing. Each write is one sealed undo step over the doc writers the
// host passes in.

import type { NewVectorElement, VectorElement, ZOp } from '@workspace/lib/vector';
import { convertToShapes, DUPLICATE_OFFSET } from '@workspace/lib/vector';
import { sealed } from '@workspace/ui/components/properties-panel';
import type * as Y from 'yjs';

export function selectAllElements(elements: readonly VectorElement[], setSelection: (ids: string[]) => void): void {
    setSelection(elements.map((el) => el.id));
}

export function duplicateSelection(
    selectedIds: string[],
    duplicateElements: (ids: string[], dx: number, dy: number) => string[],
    setSelection: (ids: string[]) => void,
    undoManager: Y.UndoManager | null,
): void {
    const ids = sealed(undoManager, () => duplicateElements(selectedIds, DUPLICATE_OFFSET, DUPLICATE_OFFSET));
    if (ids.length) setSelection(ids);
}

export function deleteSelection(
    selectedIds: string[],
    deleteElements: (ids: string[]) => void,
    setSelection: (ids: string[]) => void,
    undoManager: Y.UndoManager | null,
): void {
    sealed(undoManager, () => deleteElements(selectedIds));
    setSelection([]);
}

// What Convert to shapes writes: offered only for one element that unpacks, such as a chart that draws.
export function selectionShapes(selectedIds: string[], byId: ReadonlyMap<string, VectorElement>): VectorElement[] {
    const only = selectedIds.length === 1 ? byId.get(selectedIds[0]) : undefined;
    return only ? convertToShapes(only) : [];
}

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

// The doc's reorder within the canvas's `elements`.
export function applyZOrder(
    op: ZOp,
    elements: readonly VectorElement[],
    selectedIds: string[],
    reorderElements: (ids: string[], selectedIds: string[], op: ZOp) => void,
    undoManager: Y.UndoManager | null,
): void {
    sealed(undoManager, () =>
        reorderElements(
            elements.map((el) => el.id),
            selectedIds,
            op,
        ),
    );
}
