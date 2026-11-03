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

// Radix focuses a menu's trigger as the menu closes, and a browser then draws a ring after Escape, even when a mouse
// opened the menu. A hover-revealed ⋮, such as a calendar's, would stay shown after the pointer left. A menu the
// pointer opened gives the focus back without a ring, and one the keyboard opened as Radix does. A right-click
// outside leaves the focus where it lands, as Radix does.
test('a menu a pointer opened gives its trigger the focus back without a ring', async () => {
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
    const restored = [];
    for (const [opener, closer] of [
        ['pointer', 'Escape'],
        ['pointer', 'click outside'],
        ['pointer', 'right-click outside'],
        ['Enter', 'Escape'],
    ] as const) {
        ({ unmount } = await renderInDocument(
            createElement(
                DropdownMenu,
                null,
                createElement(DropdownMenuTrigger, null, '⋮'),
                createElement(DropdownMenuContent, null, createElement(DropdownMenuItem, null, 'Edit calendar')),
            ),
        ));
        const trigger = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-trigger"]');
        if (!trigger) throw new Error('no trigger');
        const calls = recordFocus(trigger);
        await act(async () => {
            if (opener === 'pointer') {
                trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
            } else {
                trigger.focus();
                calls.length = 0;
                trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            }
        });
        await settle();
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
        if (closer === 'Escape') await pressEscape();
        else await pressOutside(closer === 'click outside' ? 0 : 2);
        await settle();
        restored.push([opener, closer, calls.map((options) => options?.focusVisible ?? 'default')]);
        await unmount();
    }
    expect(restored).toEqual([
        ['pointer', 'Escape', [false]],
        ['pointer', 'click outside', [false]],
        ['pointer', 'right-click outside', []],
        ['Enter', 'Escape', ['default']],
    ]);
});
