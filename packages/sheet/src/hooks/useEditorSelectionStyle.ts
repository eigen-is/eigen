// The style at the open cell editor's caret or selection, so the toolbar's Bold, font, size and color
// show the run the user is in rather than the cell's own style. It follows the selection as it moves.
// Null while no cell is open, or while one is open on a formula, where the toolbar shows the cell.

import { useContext, useEffect, useState } from 'react';
import { WorkbookContext } from '../context';
import type { RunStyle } from '../state';
import { editorSelectionStyle, getFlowdata } from '../state';

export function useEditorSelectionStyle(): RunStyle | null {
    const { context, refs } = useContext(WorkbookContext);
    const [, setSelectionVersion] = useState(0);
    const isEditing = context.editingCellPosition.length > 0;

    useEffect(() => {
        if (!isEditing) return;
        const onSelectionChange = () => setSelectionVersion((version) => version + 1);
        document.addEventListener('selectionchange', onSelectionChange);
        return () => document.removeEventListener('selectionchange', onSelectionChange);
    }, [isEditing]);

    const input = refs.cellInput.current;
    if (!isEditing || !input || input.innerText.startsWith('=')) return null;
    const [r, c] = context.editingCellPosition;
    return editorSelectionStyle(input, getFlowdata(context)?.[r]?.[c]);
}
