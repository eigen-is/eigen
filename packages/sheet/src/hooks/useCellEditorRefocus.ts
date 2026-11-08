// Hands the focus back to the grid's cell input when a control lets it go: a menu or popover as it closes, such as
// the menu bar's or a tab's, the size box, or a sheet dialog. An open cell editor gets its selection back too. Radix would focus the
// control's trigger, where the grid leaves the keys to the bar, and a dialog has no trigger at all, so after Insert ›
// Row above a Delete or a typed key would do nothing. Google Sheets hands the focus back to the grid as well. Whatever
// took the focus as the control closed, such as a dialog or the next menu, keeps it.

import { focusLeftToEditor } from '@workspace/ui/components/menubar';
import { useCallback, useContext } from 'react';
import { WorkbookContext } from '../context';
import { restoreEditorSelection } from '../state';

export function useCellEditorRefocus(): (event: Event) => void {
    const { getContext, refs } = useContext(WorkbookContext);
    // The editing state is read as the control closes, not as it rendered: a dialog's OK, such as Insert function's,
    // opens the editor in the same step that closes the dialog.
    return useCallback(
        (event: Event) => {
            const input = refs.cellInput.current;
            if (!input) return;
            event.preventDefault();
            if (!focusLeftToEditor()) return;
            if (getContext().editingCellPosition.length > 0) restoreEditorSelection(input);
            else input.focus({ preventScroll: true });
        },
        [getContext, refs],
    );
}
