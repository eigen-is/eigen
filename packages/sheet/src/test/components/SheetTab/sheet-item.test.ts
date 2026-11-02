// A sheet tab's Hide hides its sheet, unless it is the last one shown: the workbook always shows one, so Hide then
// shows a notice and leaves the sheet as it was.

import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { SheetItem } = await import('../../../components/SheetTab/SheetItem');

type Sheet = import('../../../state').Sheet;

const sheet = (id: string, name: string): Sheet => ({ id, name, order: 0, config: {}, data: [[null]] });

// The tabs of these sheets, with the first one's menu opened by a right click.
async function openTabMenu(sheets: Sheet[]) {
    const dialog = await renderSheetDialog(
        () => {},
        { sheets, currentSheetId: sheets[0]?.id, allowEdit: true },
        (ctx) => ctx.sheets.map((s) => createElement(SheetItem, { key: s.id, id: s.id, sheet: s })),
    );
    await act(async () => {
        document
            .querySelector('[role="button"]')
            ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    const hide = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === 'Hide');
    if (!hide) throw new Error('no Hide item');
    await act(async () => hide.click());
    return dialog;
}

test('Hide hides a sheet while another one is shown', async () => {
    const dialog = await openTabMenu([sheet('a', 'First'), sheet('b', 'Second')]);
    expect(dialog.context().sheets.map((s) => s.hide)).toEqual([1, undefined]);
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Hide on the last shown sheet shows a notice and keeps the sheet', async () => {
    const dialog = await openTabMenu([sheet('a', 'Only')]);
    expect(dialog.context().sheets[0]?.hide).toBeUndefined();
    expect(dialog.title()).toBe('Notice');
});
