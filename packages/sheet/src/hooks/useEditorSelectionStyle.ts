// The style at the open cell editor's caret or selection, so the format controls, such as the toolbar's
// Bold, font, size and color, show the run the user is in rather than the cell's own style. It follows
// the selection as it moves. Null while no cell is open, or while one is open on a formula, where the
// controls show the cell. The menu bar reads it once and hands it to each control.

import { useContext, useEffect, useState } from 'react';
import { WorkbookContext } from '../context';
import type { RunStyle } from '../state';
import { editorSelectionStyle, getFlowdata, sameRunStyle } from '../state';

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
        // A caret that moves inside one run keeps the style object, so the controls don't re-render.
        const read = () => {
            const next = input.textContent?.startsWith('=') ? null : editorSelectionStyle(input, cell);
            setStyle((style) => (style && next && sameRunStyle(style, next) ? style : next));
        };
        read();
        document.addEventListener('selectionchange', read);
        return () => document.removeEventListener('selectionchange', read);
    }, [isEditing, cell, refs.cellInput]);

    return isEditing ? style : null;
}
