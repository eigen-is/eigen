// Insert link, or the link card's pencil, opens the link dialog in the sheet's dialog slot. OK, or Enter in the
// address, saves the link and closes. An address Sheets can't open disables OK and says why, and Cancel, Escape, the X
// or a click outside close it with the cell as it was. However it closes, the focus goes back to the grid. The range
// picker takes the dialog's place and brings it back with the draft, on the link's sheet, however the picker leaves.

import { describe, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { LinkEditCard } = await import('../../../components/LinkEditCard');
type Context = import('../../../state').Context;

const gridMouseDown = mock(() => {});

const SHEETS = [
    { id: 'id_1', name: 'Sheet1', order: 0, config: {}, data: [[null, null]] },
    { id: 'id_2', name: 'Sheet2', order: 1, config: {}, data: [[null, null]] },
];

// The link card on A1, inside a stand-in for the grid that listens as cellArea does: editing for Insert link, or the
// hover card of a link already there.
const openCard = async ({ isEditing = true, originType = 'webpage', originAddress = '' } = {}) => {
    gridMouseDown.mockClear();
    const dialog = await renderSheetDialog(
        () => {},
        {
            sheets: SHEETS,
            linkCard: {
                sheetId: 'id_1',
                r: 0,
                c: 0,
                rc: '0_0',
                originText: '',
                originType,
                originAddress,
                position: { cellLeft: 0, cellBottom: 20 },
                isEditing,
            },
        },
        (context: Context) =>
            createElement(
                'div',
                { onMouseDown: gridMouseDown },
                context.linkCard && createElement(LinkEditCard, context.linkCard),
            ),
    );
    await settle();
    return dialog;
};

// Radix starts listening for outside clicks a tick after a dialog opens, and hands the focus on a moment after one
// unmounts.
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

const openEditLink = async () => {
    const dialog = await openCard({ isEditing: false, originAddress: 'https://eigen.is' });
    await clickLabelled('Edit link');
    await settle();
    return dialog;
};

const clickLabelled = (label: string) =>
    act(async () => {
        const target = document.querySelector(`button[aria-label="${label}"]`);
        if (!(target instanceof HTMLElement)) throw new Error(`no ${label} button`);
        target.click();
    });

const clickOutside = () =>
    act(async () => {
        const overlay = document.querySelector('[data-slot="dialog-overlay"]');
        overlay?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
        overlay?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        overlay?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });

const pressEscape = () =>
    act(async () => {
        document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
    });

const link = (context: Context) => context.sheets[0].hyperlink?.['0_0'];

test('OK saves the link, writes the display text and closes', async () => {
    const dialog = await openCard();
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
    const dialog = await openCard();
    await dialog.type('Link address', 'https://eigen.is');
    await act(async () => pressEnter(dialog.field('Link address')));
    expect(link(dialog.context())).toEqual({ linkType: 'webpage', linkAddress: 'https://eigen.is' });
    expect(dialog.dialogs()).toHaveLength(0);
});

test('an address Sheets cannot open disables OK, says why, and keeps what was typed', async () => {
    const dialog = await openCard();
    await dialog.type('Link address', 'javascript:alert(1)');
    expect(dialog.button('OK')?.disabled).toBe(true);
    expect(dialog.dialogs()[0]?.textContent).toContain('Please enter a valid link');
    await act(async () => pressEnter(dialog.field('Link address')));
    expect(link(dialog.context())).toBeUndefined();
    expect(dialog.field('Link address').value).toBe('javascript:alert(1)');
    expect(dialog.dialogs()).toHaveLength(1);
});

test('Cancel closes the dialog and leaves the cell as it was', async () => {
    const dialog = await openCard();
    await dialog.type('Link address', 'https://eigen.is');
    await dialog.click('Cancel');
    expect(link(dialog.context())).toBeUndefined();
    expect(dialog.context().linkCard).toBeUndefined();
    expect(dialog.dialogs()).toHaveLength(0);
});

test('a click outside closes the dialog', async () => {
    const dialog = await openCard();
    await clickOutside();
    expect(dialog.dialogs()).toHaveLength(0);
});

test('the pencil on the hover card opens Edit link on the link as it is', async () => {
    const dialog = await openEditLink();
    expect(dialog.title()).toBe('Edit link');
    expect(dialog.field('Link address').value).toBe('https://eigen.is');
    expect(dialog.context().linkCard).toBeUndefined();
});

test("a mouse press in the dialog doesn't reach the grid", async () => {
    const dialog = await openCard();
    await act(async () => {
        dialog.field('Display text').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(gridMouseDown).not.toHaveBeenCalled();
});

describe('the focus goes back to the grid', () => {
    const closes: [string, (dialog: Awaited<ReturnType<typeof openCard>>) => Promise<unknown>][] = [
        [
            'OK',
            async (dialog) => {
                await dialog.type('Link address', 'https://eigen.is/docs');
                await dialog.click('OK');
            },
        ],
        [
            'Enter',
            async (dialog) => {
                await dialog.type('Link address', 'https://eigen.is/docs');
                await act(async () => pressEnter(dialog.field('Link address')));
            },
        ],
        ['Cancel', (dialog) => dialog.click('Cancel')],
        ['Escape', () => pressEscape()],
        [
            'the X',
            () =>
                act(async () => {
                    document.querySelector<HTMLElement>('[data-slot="dialog-close"]')?.click();
                }),
        ],
        ['a click outside', () => clickOutside()],
    ];

    for (const [name, close] of closes) {
        for (const [opened, open] of [
            ['Insert link', () => openCard()],
            ['Edit link', openEditLink],
        ] as const) {
            test(`after ${name} in ${opened}`, async () => {
                const dialog = await open();
                expect(dialog.title()).toBe(opened);
                await close(dialog);
                expect(dialog.dialogs()).toHaveLength(0);
                await settle();
                expect(document.activeElement?.id).toBe('sheet-rich-text-editor');
            });
        }
    }
});

describe('the range picker', () => {
    // Edit link on a link to B1, its display text typed, and the grid button pressed.
    const openPicker = async () => {
        const dialog = await openCard({ originType: 'cellrange', originAddress: 'Sheet1!B1' });
        await dialog.type('Display text', 'Totals');
        await clickLabelled('Select cell range');
        expect(dialog.title()).toBe('Select cell range');
        expect(dialog.context().rangeDialog.show).toBe(true);
        return dialog;
    };

    test('OK brings the dialog back with the picked range and the text as typed', async () => {
        const dialog = await openPicker();
        await dialog.type('Cell range', 'Sheet1!C2');
        await dialog.click('OK');
        expect(dialog.title()).toBe('Edit link');
        expect(dialog.field('Display text').value).toBe('Totals');
        expect(dialog.field('Cell range').value).toBe('Sheet1!C2');
        expect(dialog.context().rangeDialog.show).toBe(false);
    });

    test('Cancel brings the dialog back with the text as typed', async () => {
        const dialog = await openPicker();
        await dialog.type('Cell range', 'Sheet1!C2');
        await dialog.click('Cancel');
        expect(dialog.title()).toBe('Edit link');
        expect(dialog.field('Display text').value).toBe('Totals');
        expect(dialog.field('Cell range').value).toBe('Sheet1!B1');
        expect(dialog.context().rangeDialog.show).toBe(false);
    });

    test('a notice that takes its place lets the cell editor and the link card back', async () => {
        const dialog = await openPicker();
        await dialog.show((d) => d.showNotice('A notice'));
        expect(dialog.context().rangeDialog.show).toBe(false);
        expect(dialog.dialogs()[0]?.textContent).toContain('A notice');
    });

    test('a pick on another sheet comes back to the link on its own sheet', async () => {
        const dialog = await openPicker();
        await dialog.setContext((ctx) => {
            ctx.currentSheetId = 'id_2';
        });
        await dialog.type('Cell range', 'Sheet2!A1');
        await dialog.click('OK');
        expect(dialog.context().currentSheetId).toBe('id_1');
        await dialog.click('OK');
        expect(link(dialog.context())).toEqual({ linkType: 'cellrange', linkAddress: 'Sheet2!A1' });
    });
});
