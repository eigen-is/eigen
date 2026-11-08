// A header's right-click menu is portalled, and a portal's events bubble up the React tree. In the header's tree, the
// pointer over a menu row hovered the row or column behind it, and the highlight stayed after the menu had gone.

import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, Fragment, useContext } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { WorkbookContext } = await import('../../../context');
const { RowHeader } = await import('../../../components/SheetOverlay/RowHeader');
const { ColumnHeader } = await import('../../../components/SheetOverlay/ColumnHeader');

function Grid({ header }: { header: typeof RowHeader }) {
    const { refs } = useContext(WorkbookContext);
    return createElement(Fragment, null, createElement('div', { ref: refs.cellArea }), createElement(header));
}

async function hoverAfterMenu(header: typeof RowHeader, headerClass: string, hoverClass: string) {
    await renderSheetDialog(
        () => {},
        {
            allowEdit: true,
            visibledatarow: Array.from({ length: 40 }, (_, r) => (r + 1) * 20),
            visibledatacolumn: Array.from({ length: 20 }, (_, c) => (c + 1) * 100),
        },
        () => createElement(Grid, { header }),
    );
    await act(async () => {
        document
            .querySelector(`.${headerClass}`)
            ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    const row = document.querySelector('[role="menuitem"]');
    if (!row) throw new Error('no menu');
    await act(async () => {
        row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 300 }));
    });
    return document.querySelector(`.${hoverClass}`);
}

test('the pointer over a row header menu hovers no row', async () => {
    expect(await hoverAfterMenu(RowHeader, 'sheet-row-header', 'sheet-row-header-hover')).toBeNull();
});

test('the pointer over a column header menu hovers no column', async () => {
    expect(await hoverAfterMenu(ColumnHeader, 'sheet-col-header', 'sheet-col-header-hover')).toBeNull();
});
