// The style at the open cell editor's caret or selection, so the toolbar's Bold, font, size and color
// show the run the user is in rather than the cell's own style. It follows the selection as it moves.
// Null while no cell is open, or while one is open on a formula, where the toolbar shows the cell.

import { useContext, useEffect, useState } from 'react';
import { WorkbookContext } from '../context';
import type { RunStyle } from '../state';
import { editorSelectionStyle, getFlowdata } from '../state';

export function useEditorSelectionStyle(): RunStyle | null {
    const { context, refs } = useContext(WorkbookContext);
    // The style is state, read on each selectionchange. Read from the DOM during render, it would stay at
    // its first value in the app: the React Compiler memoizes the read, and a moved caret changes nothing
    // the compiler can see.
    const [style, setStyle] = useState<RunStyle | null>(null);
    const isEditing = context.editingCellPosition.length > 0;
    const [r, c] = context.editingCellPosition;
    const cell = isEditing ? getFlowdata(context)?.[r]?.[c] : undefined;

    useEffect(() => {
        const input = refs.cellInput.current;
        if (!isEditing || !input) {
            setStyle(null);
            return;
        }
        const read = () => setStyle(input.innerText.startsWith('=') ? null : editorSelectionStyle(input, cell));
        read();
        document.addEventListener('selectionchange', read);
        return () => document.removeEventListener('selectionchange', read);
    }, [isEditing, cell, refs.cellInput]);

    return isEditing ? style : null;
}
