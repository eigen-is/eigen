// The cell a format applies from: the focus cell of the selection, or its top-left cell without one. The custom format
// dialogs open on its format, and the format toolbar's swatches show its colors.

import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import type { Cell } from '../../engine/types';
import { getFlowdata } from '../../state';

export function useAnchorCell(): Cell | null | undefined {
    const { context } = useContext(WorkbookContext);
    const selection = context.selections?.[0];
    const row = selection?.row_focus ?? selection?.row?.[0];
    const column = selection?.column_focus ?? selection?.column?.[0];
    if (row == null || column == null) return null;
    return getFlowdata(context)?.[row]?.[column];
}
