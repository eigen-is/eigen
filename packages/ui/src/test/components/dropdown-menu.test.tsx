// A choice is a submenu whose rows check the current option, and a toggle a row checked when on: both draw the same
// check, a choice's rows read as menuitemradio and a toggle's as menuitemcheckbox.
import { afterEach, expect, mock, test } from 'bun:test';
import { recordFocus } from '../focus-calls';
import { installHappyDom } from '../happy-dom';
import { checkRows, clickRow, menuRows, openSubmenu, renderOpenMenu } from '../menu-rows';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const {
    ChoiceMenuItems,
    ChoiceMenuSub,
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} = await import('../../components/dropdown-menu');

let unmount = async () => {};
afterEach(() => unmount());

const SPACINGS = [
    { value: 1, label: 'Single' },
    { value: 1.5, label: '1.5' },
    { value: 2, label: 'Double' },
] as const;

const lastMenu = () => [...document.querySelectorAll('[role="menu"]')].at(-1);
const checkIcon = (label: string) =>
    [...(lastMenu()?.querySelectorAll('[aria-checked]') ?? [])]
        .find((row) => row.textContent?.trim() === label)
        ?.querySelector('svg')
        ?.getAttribute('class');

test('a choice is one submenu row whose options check the current one, and a pick sets its value', async () => {
    const onChange = mock((_value: number) => {});
    ({ unmount } = await renderOpenMenu(
        createElement(ChoiceMenuSub<number>, { trigger: 'Line spacing', value: 1.5, options: SPACINGS, onChange }),
    ));
    expect(menuRows()).toEqual(['Line spacing']);

    await openSubmenu('Line spacing');
    expect(checkRows()).toEqual([
        ['Single', 'false'],
        ['1.5', 'true'],
        ['Double', 'false'],
    ]);
    // The current option draws the check a toggle draws, never a dot.
    expect(checkIcon('1.5')).toContain('lucide-check');

    await clickRow('Double');
    expect(onChange.mock.calls).toEqual([[2]]);
});

test('a mixed selection checks no option', async () => {
    ({ unmount } = await renderOpenMenu(
        createElement(ChoiceMenuItems<number>, { value: undefined, options: SPACINGS, onChange: () => {} }),
    ));
    expect(checkRows()).toEqual([
        ['Single', 'false'],
        ['1.5', 'false'],
        ['Double', 'false'],
    ]);
});

test('a toggle is checked when on, and a set some of a selection has draws a dash', async () => {
    ({ unmount } = await renderOpenMenu([
        createElement(DropdownMenuCheckboxItem, { key: 'on', checked: true }, 'Tool lock'),
        createElement(DropdownMenuCheckboxItem, { key: 'off', checked: false }, 'Snap to grid'),
        createElement(DropdownMenuCheckboxItem, { key: 'some', checked: 'indeterminate' }, 'Urgent'),
    ]));
    expect(checkRows()).toEqual([
        ['Tool lock', 'true'],
        ['Snap to grid', 'false'],
        ['Urgent', 'mixed'],
    ]);
    expect([checkIcon('Tool lock'), checkIcon('Snap to grid'), checkIcon('Urgent')]).toEqual([
        expect.stringContaining('lucide-check'),
        undefined,
        expect.stringContaining('lucide-minus'),
    ]);
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
const pressEscape = () =>
    act(async () => {
        document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }),
        );
    });
const pressOutside = (button: number) =>
    act(async () => {
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button }));
    });
const menuOpen = () => document.querySelector('[role="menu"]') !== null;

// A ⋮ with one row, and the focus() calls its trigger gets, each read as its focusVisible option.
async function renderKebab(menu: Partial<Parameters<typeof DropdownMenu>[0]> = {}, content = {}) {
    ({ unmount } = await renderInDocument(
        createElement(
            DropdownMenu,
            menu,
            createElement(DropdownMenuTrigger, null, '⋮'),
            createElement(DropdownMenuContent, content, createElement(DropdownMenuItem, null, 'Edit calendar')),
        ),
    ));
    const trigger = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-trigger"]');
    if (!trigger) throw new Error('no trigger');
    const calls = recordFocus(trigger);
    const pointerOpen = () =>
        act(async () => {
            trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
        });
    return { trigger, calls, pointerOpen, rings: () => calls.map((options) => options?.focusVisible ?? 'default') };
}

// Radix focuses a menu's trigger as the menu closes, and a browser then draws a ring after Escape, even when a mouse
// opened the menu. A hover-revealed ⋮, such as a calendar's, would stay shown after the pointer left. A menu the
// pointer opened gives the focus back without a ring, and one the keyboard opened as Radix does. A right-click
// outside leaves the focus where it lands, as Radix does.
test('a menu a pointer opened gives its trigger the focus back without a ring', async () => {
    const restored = [];
    for (const [opener, closer] of [
        ['pointer', 'Escape'],
        ['pointer', 'click outside'],
        ['pointer', 'right-click outside'],
        ['Enter', 'Escape'],
    ] as const) {
        const { trigger, calls, pointerOpen, rings } = await renderKebab();
        if (opener === 'pointer') {
            await pointerOpen();
        } else {
            trigger.focus();
            calls.length = 0;
            await act(async () => {
                trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            });
        }
        await settle();
        expect(menuOpen()).toBe(true);
        if (closer === 'Escape') await pressEscape();
        else await pressOutside(closer === 'click outside' ? 0 : 2);
        await settle();
        restored.push([opener, closer, rings()]);
        await unmount();
    }
    expect(restored).toEqual([
        ['pointer', 'Escape', [false]],
        ['pointer', 'click outside', [false]],
        ['pointer', 'right-click outside', []],
        ['Enter', 'Escape', ['default']],
    ]);
});

// A caller that prevents an outside press keeps the menu open, and Radix then ignores the press. So does the focus
// once the menu closes: a menu the pointer opened still gives its trigger the focus back without a ring.
test('an outside press the caller prevented leaves the focus to the menu’s own close', async () => {
    const restored = [];
    for (const [modal, button, handler] of [
        [false, 0, 'onInteractOutside'],
        [true, 2, 'onPointerDownOutside'],
    ] as const) {
        const { pointerOpen, rings } = await renderKebab(
            { modal },
            { [handler]: (event: Event) => event.preventDefault() },
        );
        await pointerOpen();
        await settle();
        await pressOutside(button);
        await settle();
        expect(menuOpen()).toBe(true);
        await pressEscape();
        await settle();
        restored.push([handler, rings()]);
        await unmount();
    }
    expect(restored).toEqual([
        ['onInteractOutside', [false]],
        ['onPointerDownOutside', [false]],
    ]);
});

// What a press on the trigger noted lasts until the menu closes. A menu its owner opens, such as from a shortcut, had
// no press, and gives the focus back as Radix does. A trigger drawn again while the menu was open, such as a list row
// re-rendered, gets it from Radix too, where the trigger that was pressed is gone.
test('a menu gives the focus back by what opened it this time, to the trigger on the page', async () => {
    const { useState } = await import('react');
    const owner = { setOpen: (_open: boolean) => {}, redraw: () => {} };
    function Owned() {
        const [open, setOpen] = useState(false);
        const [version, setVersion] = useState(0);
        owner.setOpen = setOpen;
        owner.redraw = () => setVersion((v) => v + 1);
        return createElement(
            DropdownMenu,
            { open, onOpenChange: setOpen },
            createElement(DropdownMenuTrigger, { key: version }, '⋮'),
            createElement(DropdownMenuContent, null, createElement(DropdownMenuItem, null, 'Edit calendar')),
        );
    }
    ({ unmount } = await renderInDocument(createElement(Owned)));
    const trigger = () => document.querySelector<HTMLElement>('[data-slot="dropdown-menu-trigger"]');
    const first = trigger();
    if (!first) throw new Error('no trigger');
    const calls = recordFocus(first);
    const rings = () => calls.map((options) => options?.focusVisible ?? 'default');

    await act(async () => {
        first.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    });
    await settle();
    await pressEscape();
    await settle();
    expect(rings()).toEqual([false]);

    await act(async () => owner.setOpen(true));
    await settle();
    expect(menuOpen()).toBe(true);
    await pressEscape();
    await settle();
    expect(rings()).toEqual([false, 'default']);

    await act(async () => {
        first.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    });
    await settle();
    await act(async () => owner.redraw());
    const second = trigger();
    expect(second === first || !second).toBe(false);
    await pressEscape();
    await settle();
    expect(document.activeElement).toBe(second);
});

// A browser takes the focus from an element as it leaves the page, and sends its focusout. happy-dom keeps it there.
function blurWhatLeavesThePage(): () => void {
    const removeChild = Node.prototype.removeChild;
    Node.prototype.removeChild = function <T extends Node>(child: T): T {
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && child.contains(focused)) focused.blur();
        removeChild.call(this, child);
        return child;
    };
    return () => {
        Node.prototype.removeChild = removeChild;
    };
}

// Drive's list takes the focus whenever it falls to the page body, as it does the moment a closing menu leaves the
// page, before the menu gives the focus back. The trigger gets it all the same, after a pointer and after a key, also
// where the list and the menu sit in a dialog, as in a file picker.
test('a menu beside a list that takes the focus from the body gives its trigger the focus back', async () => {
    const { useRef } = await import('react');
    const { useKeyboardListNavigation } = await import('../../hooks/use-keyboard-list-navigation');
    const { Dialog, DialogContent, DialogTitle } = await import('../../components/dialog');
    function Listing({ inDialog }: { inDialog: boolean }) {
        const containerRef = useRef<HTMLDivElement>(null);
        useKeyboardListNavigation<string>({ items: [], getId: (item) => item, onSelect: () => {}, containerRef });
        const listing = [
            createElement('div', { key: 'list', ref: containerRef, role: 'grid', tabIndex: 0 }),
            createElement(
                DropdownMenu,
                { key: 'menu' },
                createElement(DropdownMenuTrigger, null, 'New'),
                createElement(DropdownMenuContent, null, createElement(DropdownMenuItem, null, 'New folder')),
            ),
        ];
        if (!inDialog) return listing;
        return createElement(
            Dialog,
            { open: true },
            createElement(
                DialogContent,
                { 'aria-describedby': undefined },
                createElement(DialogTitle, null, 'Pick'),
                listing,
            ),
        );
    }
    const restore = blurWhatLeavesThePage();
    const focused = [];
    try {
        for (const [inDialog, opener] of [
            [false, 'pointer'],
            [false, 'Enter'],
            [true, 'pointer'],
            [true, 'Enter'],
        ] as const) {
            ({ unmount } = await renderInDocument(createElement(Listing, { inDialog })));
            const trigger = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-trigger"]');
            if (!trigger) throw new Error('no trigger');
            const event =
                opener === 'pointer'
                    ? new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
                    : new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
            await act(async () => {
                trigger.dispatchEvent(event);
            });
            await settle();
            expect(menuOpen()).toBe(true);
            await pressEscape();
            // The menu gives the focus back once it has left the page, which takes longer on a busy machine.
            for (let turn = 0; turn < 100 && document.activeElement !== trigger; turn++) await settle();
            focused.push([
                inDialog ? 'dialog' : 'page',
                opener,
                document.activeElement === trigger ? 'trigger' : document.activeElement?.role,
            ]);
            await unmount();
        }
    } finally {
        restore();
    }
    expect(focused).toEqual([
        ['page', 'pointer', 'trigger'],
        ['page', 'Enter', 'trigger'],
        ['dialog', 'pointer', 'trigger'],
        ['dialog', 'Enter', 'trigger'],
    ]);
});
