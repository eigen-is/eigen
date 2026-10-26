// A choice is a submenu whose rows check the current option, and a toggle a row checked when on: both draw the same
// check, a choice's rows read as menuitemradio and a toggle's as menuitemcheckbox.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';
import { checkRows, clickRow, menuRows, openSubmenu, renderOpenMenu } from '../menu-rows';

installHappyDom();

const { createElement } = await import('react');
const { ChoiceMenuItems, ChoiceMenuSub, DropdownMenuCheckboxItem } = await import('../../components/dropdown-menu');

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
