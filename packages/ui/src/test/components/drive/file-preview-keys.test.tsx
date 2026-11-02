// The overlay's keys listen on the document, and everything its content can open above it — a picker,
// the `.eml` reader header's details popover — is a layer of its own that handles Escape itself. What is
// pinned here is that the overlay stands its keys down while such a layer is open, and that Space on a
// focused control inside the overlay is that control's own activation rather than a close. Every layer
// portals to <body> as it opens, so document order says which one is on top and whose Escape it is.
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
const { isLayerAbove } = await import('../../../hooks/use-dialog-open');

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

    const press = async (key: string, from: EventTarget = document) => {
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
    const button = document.querySelector('[data-preview-overlay] button');
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

// A menu and a listbox are layers above the overlay the same way a dialog is, and their own Escape
// runs on the capture phase of the very keydown the overlay hears later: presence is settled by then,
// so where the key was pressed is what says whose Escape it was.
test.each(['menu', 'listbox'])('Escape inside an open %s above the overlay is not the overlay’s', async (role) => {
    const { closed, press, cleanup } = await mount(false);
    const layer = document.createElement('div');
    layer.setAttribute('role', role);
    const item = document.createElement('button');
    layer.append(item);
    document.body.append(layer);

    await press('Escape', item);
    expect(closed.count).toBe(0);

    // The same key, pressed anywhere else, is still the overlay's.
    layer.remove();
    await press('Escape');
    expect(closed.count).toBe(1);
    await cleanup();
});

// The overlay opened from inside a dialog (a stickies card's attachments): that dialog sits below it, earlier
// in the document, and its focus trap holds focus, so neither its presence nor a key pressed in it is a layer above.
test('a dialog the overlay was opened over leaves the overlay its keys', async () => {
    const card = document.createElement('div');
    card.setAttribute('role', 'dialog');
    const chip = document.createElement('a');
    chip.href = '#';
    card.append(chip);
    document.body.append(card);

    const { closed, paged, press, cleanup } = await mount(false);
    await press('ArrowRight', chip);
    expect(paged.count).toBe(1);
    await press('Escape', chip);
    expect(closed.count).toBe(1);
    await cleanup();
    card.remove();
});

// Stickies: a card is a dialog holding a chat; an attachment in it opens the preview over the card, and Save to Drive
// in the preview's footer opens over the preview. None of them is told where it sits: each Escape and each click
// closes the top layer alone, and the card stays.
async function mountStickiesChain() {
    const card = { closed: 0 };
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
                    { 'aria-describedby': undefined },
                    createElement(DialogTitle, null, 'Groceries'),
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
    const preview = () => document.querySelector('[data-preview-overlay]');
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
    await run(controls.openAttachment);
    return { card, save, controls, layerTitled, preview, pressEscape, press, run, unmount };
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
