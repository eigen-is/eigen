// The app bar's menus are one Radix Menubar: an open menu leaves the page live, so one press on another trigger opens
// that menu, and the rows every DropdownMenu shows work in a bar menu too, a phone's drill-in pages included.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';
import { checkRows, clickRow, menuRows, openSubmenu } from '../../../menu-rows';
import { renderInDocument } from '../../../render-in-document';

const window = installHappyDom();

const { act, createElement } = await import('react');
const { ChoiceMenuSub, DropdownMenuItem } = await import('../../../../components/dropdown-menu');
const { Menubar } = await import('../../../../components/menubar');
const { AppBarMenu } = await import('../../../../components/layout/toolbar/app-bar-menu');

let unmount = async () => {};
afterEach(() => unmount());

const SPACINGS = [
    { value: 1, label: 'Single' },
    { value: 2, label: 'Double' },
] as const;

const onChange = mock((_value: number) => {});

async function render(width: number) {
    window.happyDOM.setViewport({ width, height: 900 });
    onChange.mockClear();
    ({ unmount } = await renderInDocument(
        createElement(
            Menubar,
            null,
            createElement(AppBarMenu, {
                label: 'Format',
                children: [
                    createElement(DropdownMenuItem, { key: 'bold' }, 'Bold'),
                    createElement(ChoiceMenuSub<number>, {
                        key: 'spacing',
                        trigger: 'Line spacing',
                        value: 1,
                        options: SPACINGS,
                        onChange,
                    }),
                ],
            }),
            createElement(AppBarMenu, { label: 'Edit', children: createElement(DropdownMenuItem, null, 'Undo') }),
        ),
    ));
}

const trigger = (label: string) =>
    [...document.querySelectorAll('button[aria-haspopup="menu"]')].find((button) => button.textContent === label);

// A pointer reaches a trigger before it presses it, as a mouse or a finger does.
async function hover(label: string) {
    await act(async () => {
        trigger(label)?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    });
    // Radix starts listening for a press outside a new menu a tick after it opens.
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
}

// A press focuses the button it lands on, as a browser does, unless a handler prevents that.
async function press(label: string) {
    await hover(label);
    const button = trigger(label);
    if (!(button instanceof HTMLElement)) throw new Error(`no ${label} trigger`);
    await act(async () => {
        const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
        button.dispatchEvent(down);
        if (!down.defaultPrevented) button.focus();
    });
}

// The label of the one open menu's trigger, read through the menu's aria-labelledby.
const openMenu = () => {
    const menus = [...document.querySelectorAll('[role="menu"]')];
    if (menus.length !== 1) return `${menus.length} menus`;
    return document.getElementById(menus[0]?.getAttribute('aria-labelledby') ?? '')?.textContent;
};

test('an open menu leaves the page live, and one press on another trigger opens its menu', async () => {
    await render(1600);
    await press('Format');
    expect(openMenu()).toBe('Format');
    expect(document.body.style.pointerEvents).not.toBe('none');

    // Moving onto Edit opens it already; the press the user aimed at Edit keeps it open.
    await hover('Edit');
    expect(openMenu()).toBe('Edit');
    await press('Edit');
    expect(openMenu()).toBe('Edit');
    expect(menuRows()).toEqual(['Undo']);
    // The press leaves the focus in the menu, where the arrow keys work, not on the trigger.
    expect(document.activeElement?.getAttribute('role')).toBe('menu');

    // A second press on the open trigger closes the bar.
    await press('Edit');
    expect(openMenu()).toBe('0 menus');
});

test("a DropdownMenu's rows work in a bar menu: a choice's submenu checks the current option and a pick sets it", async () => {
    await render(1600);
    await press('Format');
    await openSubmenu('Line spacing');
    expect(checkRows()).toEqual([
        ['Single', 'true'],
        ['Double', 'false'],
    ]);
    await clickRow('Double');
    expect(onChange.mock.calls).toEqual([[2]]);
});

// The rows a phone shows: a drill-in page hides the rows of the pages it covers.
const shownRows = () =>
    [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')]
        .filter((row) => !row.closest('.hidden'))
        .map((row) => row.textContent?.trim());

test('on a phone a submenu is a page of the bar menu, and the menu reopens at its root', async () => {
    await render(390);
    await press('Format');
    expect(shownRows()).toEqual(['Bold', 'Line spacing']);

    await openSubmenu('Line spacing');
    // Still one menu: the page took the root rows' place, under a back row named for the submenu.
    expect(document.querySelectorAll('[role="menu"]').length).toBe(1);
    expect(shownRows()).toEqual(['Line spacing', 'Single', 'Double']);

    await act(async () =>
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(document.querySelectorAll('[role="menu"]').length).toBe(0);
    await press('Format');
    expect(shownRows()).toEqual(['Bold', 'Line spacing']);
});
