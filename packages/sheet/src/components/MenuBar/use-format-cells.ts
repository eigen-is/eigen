// The Format menu and the format toolbar run a format through this, so it reaches the cells or, while a cell is
// open, the editor's selected text: the handlers take the cell input, which holds that selection.

import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import type { Context } from '../../state';

export function useFormatCells() {
    const { setContext, refs } = useContext(WorkbookContext);
    return (apply: (ctx: Context, input: HTMLDivElement) => void) =>
        setContext((ctx) => {
            const input = refs.cellInput.current;
            if (input) apply(ctx, input);
        });
}
