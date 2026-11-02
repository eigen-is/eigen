// The preview is a Radix dialog, so Radix's stacks decide which layer gets Escape, an outside click, the focus and
// the wheel, and a layer its content opens above it, such as a picker or the `.eml` reader header's details popover,
// handles Escape itself. The preview's own keys listen on the document and act only on a key pressed inside it. Space
// on a focused control inside it is that control's own activation rather than a close. Every layer portals to <body>
// as it opens, so document order says which one paints on top at the same z-index.
import { expect, mock, test } from 'bun:test';
import { subjectFromMailAttachment } from '@workspace/lib/file-subject';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const session = { user: { id: 'owner-1' } };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { act, createElement, Fragment, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Popover, PopoverContent, PopoverTrigger } = await import('../../../components/popover');
const { PreviewContext } = await import('../../../components/preview-provider/preview-context');
const { FilePreview } = await import('../../../components/drive/file-preview');
const { PreviewProvider, usePreview } = await import('../../../components/preview-provider/preview-provider');
const { Dialog, DialogContent, DialogTitle } = await import('../../../components/dialog');
const { FormDialog, FormDialogForm } = await import('../../../components/form-dialog');
const { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } = await import(
    '../../../components/dropdown-menu'
);

// Every layer portals to <body> in the order it opened, so a later one in the document paints above at z-50.
const isLayerAbove = (base: Element, layer: Element) =>
    (base.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

// A part with no preview of its own: the overlay draws its file card, and no query runs.
const subject = subjectFromMailAttachment('owner-1', 'message-1', 0, {
    contentType: 'application/octet-stream',
    filename: 'ledger.bin',
    size: 2048,
});
const next = subjectFromMailAttachment('owner-1', 'message-1', 1, {
    contentType: 'application/octet-stream',
    filename: 'journal.bin',
    size: 2048,
});

const preview = { openPreview: () => {}, updatePreview: () => {}, closePreview: () => {}, isPreviewOpen: true };

async function mount(popoverOpen: boolean) {
    const closed = { count: 0 };
    const paged = { count: 0 };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            createElement(
                QueryClientProvider,
                { client: new QueryClient() },
                createElement(
                    PreviewContext.Provider,
                    { value: preview },
                    createElement(FilePreview, {
                        subject,
                        siblings: [subject, next],
                        onClose: () => {
                            closed.count += 1;
                        },
                        onPrev: () => {},
                        onNext: () => {
                            paged.count += 1;
                        },
                    }),
                    // The shape of the header's details popover: Radix portals it to the body, above the overlay.
                    createElement(
                        Popover,
                        { open: popoverOpen },
                        createElement(PopoverTrigger, null, 'to: Ada'),
                        createElement(PopoverContent, null, 'from: ada@example.com'),
                    ),
                ),
            ),
        );
    });

    // The preview holds the focus, so a key goes where the focus is unless the test presses it elsewhere.
    const press = async (key: string, from: EventTarget = document.activeElement ?? document) => {
        const event = new KeyboardEvent('keydown', {
            key,
            code: key === ' ' ? 'Space' : key,
            bubbles: true,
            cancelable: true,
        });
        await act(async () => {
            from.dispatchEvent(event);
        });
        return event;
    };
    const cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    return { closed, paged, press, cleanup };
}

test('Escape closes the overlay when nothing is open above it', async () => {
    const { closed, press, cleanup } = await mount(false);
    await press('Escape');
    expect(closed.count).toBe(1);
    await cleanup();
});

test('Escape with a layer open above the overlay is that layer’s, not the overlay’s', async () => {
    const { closed, press, cleanup } = await mount(true);
    await press('Escape');
    expect(closed.count).toBe(0);
    await cleanup();
});

test('Space on a focused control inside the overlay is that control’s own activation', async () => {
    const { closed, press, cleanup } = await mount(false);
    const button = document.querySelector('[data-slot="file-preview"] button');
    if (!button) throw new Error('the overlay drew no button');
    const onButton = await press(' ', button);
    expect(closed.count).toBe(0);
    // The overlay's own hotkey must prevent no default here, or the button never presses.
    expect(onButton.defaultPrevented).toBe(false);

    const onOverlay = await press(' ');
    expect(closed.count).toBe(1);
    expect(onOverlay.defaultPrevented).toBe(true);
    await cleanup();
});

// The keys listen on the document. A layer above the preview holds the focus while it is open, so a key pressed
// outside the preview is not the preview's.
test('the arrows page from inside the preview, and a key pressed outside it is not the preview’s', async () => {
    const { closed, paged, press, cleanup } = await mount(false);
    await press('ArrowRight');
    expect(paged.count).toBe(1);

    const outside = document.createElement('div');
    document.body.append(outside);
    await press('ArrowRight', outside);
    await press(' ', outside);
    expect(paged.count).toBe(1);
    expect(closed.count).toBe(0);
    outside.remove();
    await cleanup();
});

// Stickies: a card is a dialog holding a chat; an attachment in it opens the preview over the card, and Save to Drive
// in the preview's footer opens over the preview. None of them is told where it sits: each Escape and each click
// closes the top layer alone, and the card stays.
async function mountStickiesChain() {
    const card = { closed: 0, pressedOutside: 0 };
    const save = { closed: 0 };
    const controls = { openAttachment: () => {}, openSave: () => {}, openMenu: () => {} };
    function Card() {
        const { openPreview } = usePreview();
        const [saveOpen, setSaveOpen] = useState(false);
        const [menuOpen, setMenuOpen] = useState(false);
        controls.openAttachment = () => openPreview(subject, [subject, next]);
        controls.openSave = () => setSaveOpen(true);
        controls.openMenu = () => setMenuOpen(true);
        return createElement(
            Fragment,
            null,
            createElement(
                Dialog,
                {
                    open: true,
                    onOpenChange: () => {
                        card.closed += 1;
                    },
                },
                createElement(
                    DialogContent,
                    {
                        'aria-describedby': undefined,
                        onPointerDownOutside: () => {
                            card.pressedOutside += 1;
                        },
                    },
                    createElement(DialogTitle, null, 'Groceries'),
                    createElement('button', null, 'Unassigned'),
                    createElement('a', { href: '#', 'data-chip': '' }, 'basket.bin'),
                ),
            ),
            createElement(FormDialog, {
                open: saveOpen,
                onOpenChange: (open: boolean) => {
                    if (!open) save.closed += 1;
                    setSaveOpen(open);
                },
                title: 'Save to Drive',
                children: createElement(FormDialogForm, {
                    onSubmit: () => {},
                    submitLabel: 'Save here',
                    children: createElement(
                        DropdownMenu,
                        { open: menuOpen, onOpenChange: setMenuOpen },
                        createElement(DropdownMenuTrigger, null, 'Folder actions'),
                        createElement(DropdownMenuContent, null, createElement(DropdownMenuItem, null, 'Rename')),
                    ),
                }),
            }),
        );
    }
    const { unmount } = await renderInDocument(createElement(PreviewProvider, null, createElement(Card)));
    // Radix starts listening for outside clicks a tick after a layer opens.
    const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    const run = async (action: () => void) => {
        await act(async () => action());
        await settle();
    };
    const layerTitled = (title: string) =>
        [...document.querySelectorAll('[data-slot="dialog-content"]')].find(
            (layer) => layer.querySelector('h2')?.textContent === title,
        );
    const preview = () => document.querySelector('[data-slot="file-preview"]');
    const chip = () => document.querySelector<HTMLElement>('[data-chip]');
    const pressEscape = () =>
        act(async () => {
            (document.activeElement ?? document).dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }),
            );
        });
    // Radix waits for the click before it closes a layer, so the whole press goes in.
    const press = async (target: Element | null | undefined) => {
        if (!target) throw new Error('nothing to press');
        await act(async () => {
            target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
            target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
        });
        await settle();
    };
    await settle();
    // The attachment chip in the card has the focus when it opens the preview, as after a click on it.
    chip()?.focus();
    await run(controls.openAttachment);
    return { card, save, chip, controls, layerTitled, preview, pressEscape, press, run, settle, unmount };
}

const noZAbove50 = (element: Element | null | undefined) => expect(element?.className).not.toMatch(/\bz-\[/);

test('Stickies: card, preview and Save to Drive stack in the order they opened, and each Escape closes the top one', async () => {
    const { card, save, controls, layerTitled, preview, pressEscape, run, unmount } = await mountStickiesChain();
    await run(controls.openSave);
    const cardContent = layerTitled('Groceries');
    const overlay = preview();
    const saveContent = layerTitled('Save to Drive');
    if (!cardContent || !overlay || !saveContent) throw new Error('a layer did not open');
    expect(isLayerAbove(cardContent, overlay)).toBe(true);
    expect(isLayerAbove(overlay, saveContent)).toBe(true);
    for (const layer of [cardContent, overlay, saveContent]) noZAbove50(layer);

    await pressEscape();
    expect(save.closed).toBe(1);
    expect(preview()).not.toBeNull();
    expect(card.closed).toBe(0);

    await pressEscape();
    expect(preview()).toBeNull();
    expect(card.closed).toBe(0);

    await pressEscape();
    expect(card.closed).toBe(1);
    await unmount();
});

test('Stickies: X, Cancel and a click outside close Save to Drive alone, and the backdrop closes the preview alone', async () => {
    const { card, save, controls, layerTitled, preview, press, run, unmount } = await mountStickiesChain();
    const overlays = () => [...document.querySelectorAll('[data-slot="dialog-overlay"]')];

    await run(controls.openSave);
    await press(layerTitled('Save to Drive')?.querySelector('[data-slot="dialog-close"]'));
    expect(save.closed).toBe(1);

    await run(controls.openSave);
    await press(
        [...(layerTitled('Save to Drive')?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Cancel'),
    );
    expect(save.closed).toBe(2);

    await run(controls.openSave);
    await press(overlays().at(-1));
    expect(save.closed).toBe(3);
    expect(preview()).not.toBeNull();
    expect(card.closed).toBe(0);

    await press(preview());
    expect(preview()).toBeNull();
    expect(card.closed).toBe(0);
    await unmount();
});

test('a menu opened in a dialog over the preview portals after both, and its Escape closes only the menu', async () => {
    const { card, save, controls, layerTitled, preview, pressEscape, run, unmount } = await mountStickiesChain();
    await run(controls.openSave);
    await run(controls.openMenu);
    const overlay = preview();
    const saveContent = layerTitled('Save to Drive');
    const menu = document.querySelector('[role="menu"]');
    if (!overlay || !saveContent || !menu) throw new Error('a layer did not open');
    expect(isLayerAbove(overlay, menu)).toBe(true);
    expect(isLayerAbove(saveContent, menu)).toBe(true);
    noZAbove50(menu);

    await pressEscape();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(save.closed).toBe(0);
    expect(preview()).not.toBeNull();
    expect(card.closed).toBe(0);
    await unmount();
});

// In a browser React closes the preview before the click reaches the document, where Radix decides whether the card
// was clicked outside, so a card that heard the press would find no preview over it and close. Dispatched from a test,
// React closes it later, so what is pinned is that the card never hears the press at all.
test('Stickies: a press on the preview’s backdrop closes the preview, and the card under it never hears it', async () => {
    const { card, preview, press, unmount } = await mountStickiesChain();
    await press(preview());
    expect(preview()).toBeNull();
    expect(card.pressedOutside).toBe(0);
    expect(card.closed).toBe(0);
    await unmount();
});

test('Stickies: the preview over a card holds the focus, its Tab and its wheel', async () => {
    const { preview, unmount } = await mountStickiesChain();
    const overlay = preview();
    if (!overlay) throw new Error('the preview did not open');
    expect(overlay.contains(document.activeElement)).toBe(true);

    // A long text preview scrolls: the card's scroll lock must not swallow the wheel.
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    Object.defineProperties(scroller, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } });
    overlay.append(scroller);
    const wheel = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    scroller.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    scroller.remove();

    // Tab from the last control wraps to the first, never into the card behind.
    const last = [...overlay.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')].at(-1);
    last?.focus();
    await act(async () => {
        last?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(overlay.contains(document.activeElement)).toBe(true);
    await unmount();
});

test('Stickies: Space where the preview put the focus closes it, and the focus goes back to the chip', async () => {
    const { card, chip, preview, settle, unmount } = await mountStickiesChain();
    await act(async () => {
        (document.activeElement ?? document).dispatchEvent(
            new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }),
        );
    });
    await settle();
    expect(preview()).toBeNull();
    expect(card.closed).toBe(0);
    expect(document.activeElement).toBe(chip());
    await unmount();
});
