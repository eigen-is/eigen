// Hands the focus back to the open cell editor, with the selection it had, when a control of the menu bar
// lets it go: a menu or popover as it closes, or the size box. Radix would focus the menu's trigger, where
// the next keys type nothing and Enter can't commit the cell. The menu bar passes the one handler to
// every such control. While no cell is open, the control keeps its own behavior, and a dialog the menu
// opened, such as Data verification, keeps the focus it took.

import { useContext } from 'react';
import { WorkbookContext } from '../context';
import { restoreEditorSelection } from '../state';

export function useCellEditorRefocus(): (event: Event) => void {
    const { context, refs } = useContext(WorkbookContext);
    const isEditing = context.editingCellPosition.length > 0;
    return (event) => {
        const input = refs.cellInput.current;
        if (!isEditing || !input) return;
        event.preventDefault();
        if (!document.activeElement?.closest('[role="dialog"]')) restoreEditorSelection(input);
    };
}
