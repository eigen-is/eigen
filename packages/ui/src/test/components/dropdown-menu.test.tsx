// A choice is a submenu whose rows check the current option, and a toggle a row checked when on: both draw the same
// check, a choice's rows read as menuitemradio and a toggle's as menuitemcheckbox.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';
import { menuRows } from '../menu-rows';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const {
    ChoiceMenuItems,
    ChoiceMenuSub,
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuTrigger,
} = await import('../../components/dropdown-menu');

let unmount = async () => {};
afterEach(() => unmount());

const SPACINGS = [
    { value: 1, label: 'Single' },
    { value: 1.5, label: '1.5' },
    { value: 2, label: 'Double' },
] as const;

async function render(...rows: ReturnType<typeof createElement>[]) {
    ({ unmount } = await renderInDocument(
        createElement(
            DropdownMenu,
            { open: true },
            createElement(DropdownMenuTrigger, null, 'Menu'),
            createElement(DropdownMenuContent, null, ...rows),
        ),
    ));
}

async function openSubmenu(label: string) {
    const trigger = [...document.querySelectorAll('[role="menuitem"]')].find(
        (row) => row.textContent?.trim() === label,
    );
    await act(async () => {
        trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    });
}

const lastMenu = () => [...document.querySelectorAll('[role="menu"]')].at(-1);
const checked = (role: string) =>
    [...(lastMenu()?.querySelectorAll(`[role="${role}"][aria-checked="true"]`) ?? [])].map((row) =>
        row.textContent?.trim(),
    );

test('a choice is one submenu row whose options check the current one, and a pick sets its value', async () => {
    const onChange = mock((_value: number) => {});
    await render(
        createElement(ChoiceMenuSub<number>, { trigger: 'Line spacing', value: 1.5, options: SPACINGS, onChange }),
    );
    expect(menuRows()).toEqual(['Line spacing']);

    await openSubmenu('Line spacing');
    const options = [...(lastMenu()?.querySelectorAll('[role="menuitemradio"]') ?? [])];
    expect(options.map((row) => row.textContent?.trim())).toEqual(['Single', '1.5', 'Double']);
    expect(checked('menuitemradio')).toEqual(['1.5']);
    // The current option draws the check a toggle draws, never a dot.
    const current = options.find((row) => row.getAttribute('aria-checked') === 'true');
    expect(current?.querySelector('svg')?.getAttribute('class')).toContain('lucide-check');

    const double = options.find((row) => row.textContent?.trim() === 'Double');
    await act(async () => double?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onChange.mock.calls).toEqual([[2]]);
});

test('a mixed selection checks no option', async () => {
    await render(createElement(ChoiceMenuItems<number>, { value: undefined, options: SPACINGS, onChange: () => {} }));
    expect(menuRows()).toEqual(['Single', '1.5', 'Double']);
    expect(checked('menuitemradio')).toEqual([]);
});

test('a toggle is checked when on, and a set some of a selection has draws a dash', async () => {
    await render(
        createElement(DropdownMenuCheckboxItem, { key: 'on', checked: true }, 'Tool lock'),
        createElement(DropdownMenuCheckboxItem, { key: 'off', checked: false }, 'Snap to grid'),
        createElement(DropdownMenuCheckboxItem, { key: 'some', checked: 'indeterminate' }, 'Urgent'),
    );
    expect(checked('menuitemcheckbox')).toEqual(['Tool lock']);
    const rows = [...(lastMenu()?.querySelectorAll('[role="menuitemcheckbox"]') ?? [])];
    expect(
        rows.map((row) => [row.getAttribute('aria-checked'), row.querySelector('svg')?.getAttribute('class')]),
    ).toEqual([
        ['true', expect.stringContaining('lucide-check')],
        ['false', undefined],
        ['mixed', expect.stringContaining('lucide-minus')],
    ]);
});
