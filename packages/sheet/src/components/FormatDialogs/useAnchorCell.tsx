import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import type { Cell } from '../../engine/types';
import { getFlowdata } from '../../state';

// Cell under the selection anchor (focus, or range start without one) — seeds
// the custom-format dialogs and drives the FormatToolbar swatches.
export function useAnchorCell(): Cell | null | undefined {
    const { context } = useContext(WorkbookContext);
    const selection = context.selections?.[0];
    const row = selection?.row_focus ?? selection?.row?.[0];
    const column = selection?.column_focus ?? selection?.column?.[0];
    if (row == null || column == null) return null;
    return getFlowdata(context)?.[row]?.[column];
}
