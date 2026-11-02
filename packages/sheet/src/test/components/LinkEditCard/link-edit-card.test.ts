// The link card's editor is a dialog the grid draws while ctx.linkCard is editing. OK, or Enter in the address,
// saves the link and closes. An address Sheets can't open disables OK and says why, and Cancel, Escape or a click
// outside close it with the cell as it was. Its keys and mouse presses never reach the grid's handlers around it.

import { expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { LinkEditCard } = await import('../../../components/LinkEditCard');
type Context = import('../../../state').Context;

const gridKeyDown = mock(() => {});
const gridMouseDown = mock(() => {});

// The editor open on A1, inside a stand-in for the grid that listens as cellArea does.
const openEditor = async () => {
    gridKeyDown.mockClear();
    gridMouseDown.mockClear();
    const dialog = await renderSheetDialog(
        () => {},
        {
            linkCard: {
                sheetId: 'id_1',
                r: 0,
                c: 0,
                rc: '0_0',
                originText: '',
                originType: 'webpage',
                originAddress: '',
                position: { cellLeft: 0, cellBottom: 20 },
                isEditing: true,
            },
        },
        (context: Context) =>
            createElement(
                'div',
                { onKeyDown: gridKeyDown, onMouseDown: gridMouseDown },
                context.linkCard && createElement(LinkEditCard, context.linkCard),
            ),
    );
    // Radix starts listening for outside clicks a tick after the dialog opens.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    return dialog;
};

const link = (context: Context) => context.sheets[0].hyperlink?.['0_0'];

test('OK saves the link, writes the display text and closes', async () => {
    const dialog = await openEditor();
    expect(dialog.dialogs()).toHaveLength(1);
    expect(dialog.title()).toBe('Insert link');
    expect(dialog.footer()).toEqual(['Cancel', 'OK']);
    expect(dialog.button('OK')?.dataset.size).toBe('default');
    expect(document.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
    await dialog.type('Display text', 'Eigen');
    await dialog.type('Link address', 'https://eigen.is');
    await dialog.click('OK');
    expect(link(dialog.context())).toEqual({ linkType: 'webpage', linkAddress: 'https://eigen.is' });
    expect(dialog.context().sheets[0].data?.[0]?.[0]?.v).toBe('Eigen');
    expect(dialog.context().linkCard).toBeUndefined();
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Enter in the address submits', async () => {
    const dialog = await openEditor();
    await dialog.type('Link address', 'https://eigen.is');
    await act(async () => pressEnter(dialog.field('Link address')));
    expect(link(dialog.context())).toEqual({ linkType: 'webpage', linkAddress: 'https://eigen.is' });
    expect(dialog.dialogs()).toHaveLength(0);
});

test('an address Sheets cannot open disables OK, says why, and keeps what was typed', async () => {
    const dialog = await openEditor();
    await dialog.type('Link address', 'javascript:alert(1)');
    expect(dialog.button('OK')?.disabled).toBe(true);
    expect(dialog.dialogs()[0]?.textContent).toContain('Please enter a valid link');
    await act(async () => pressEnter(dialog.field('Link address')));
    expect(link(dialog.context())).toBeUndefined();
    expect(dialog.field('Link address').value).toBe('javascript:alert(1)');
    expect(dialog.context().linkCard?.isEditing).toBe(true);
});

test('Cancel closes the editor and leaves the cell as it was', async () => {
    const dialog = await openEditor();
    await dialog.type('Link address', 'https://eigen.is');
    await dialog.click('Cancel');
    expect(link(dialog.context())).toBeUndefined();
    expect(dialog.context().linkCard).toBeUndefined();
    expect(dialog.dialogs()).toHaveLength(0);
});

test('a click outside closes the editor', async () => {
    const dialog = await openEditor();
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    await act(async () => {
        overlay?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
        overlay?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        overlay?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    expect(dialog.context().linkCard).toBeUndefined();
});

test("keys and mouse presses in the editor don't reach the grid", async () => {
    const dialog = await openEditor();
    const field = dialog.field('Display text');
    await act(async () => {
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
        field.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(gridKeyDown).not.toHaveBeenCalled();
    expect(gridMouseDown).not.toHaveBeenCalled();
});
