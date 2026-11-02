// Hands the focus back to the grid's cell input when a control of the menu bar lets it go: a menu or popover as it
// closes, or the size box. An open cell editor gets its selection back too. Radix would focus the menu's trigger,
// where the grid leaves the keys to the bar, so after Insert › Row above a Delete or a typed key would do nothing.
// Google Sheets hands the focus back to the grid as well. The menu bar passes the one handler to every such control.
// Whatever took the focus as the control closed, such as a dialog or the next menu, keeps it.

import { focusLeftToEditor } from '@workspace/ui/components/menubar';
import { useContext } from 'react';
import { WorkbookContext } from '../context';
import { restoreEditorSelection } from '../state';

export function useCellEditorRefocus(): (event: Event) => void {
    const { context, refs } = useContext(WorkbookContext);
    const isEditing = context.editingCellPosition.length > 0;
    return (event) => {
        const input = refs.cellInput.current;
        if (!input) return;
        event.preventDefault();
        if (!focusLeftToEditor()) return;
        if (isEditing) restoreEditorSelection(input);
        else input.focus({ preventScroll: true });
    };
}
