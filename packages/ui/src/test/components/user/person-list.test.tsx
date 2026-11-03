// A person list with a menu gives each row a ⋮ button that opens it. A mouse user sees the button on hover only. Tab
// skips it, since the list's menu key, Shift+F10 or the ContextMenu key, opens the menu of the row under the cursor.
import { expect, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { expectKeyboardReveal } from '../../hover-reveal';
import { menuRows } from '../../menu-rows';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { DropdownMenuItem } = await import('../../../components/dropdown-menu');
const { PersonList } = await import('../../../components/user/person-list');

type Person = { id: string; name: string };
const PEOPLE: Person[] = [
    { id: 'ada', name: 'Ada' },
    { id: 'grace', name: 'Grace' },
];

// The menu names the people it acts on.
async function renderList(activeId?: string) {
    const { container } = await renderInDocument(
        createElement(PersonList<Person>, {
            items: PEOPLE,
            searchQuery: '',
            activeId,
            getId: (person) => person.id,
            getName: (person) => person.name,
            getSearchFields: (person) => [person.name],
            onRowClick: () => {},
            renderPerson: (person) => createElement('span', null, person.name),
            emptyState: null,
            renderMenuItems: (items) =>
                createElement(DropdownMenuItem, null, `Menu of ${items.map((p) => p.name).join(', ')}`),
        }),
    );
    return container;
}

test('each row’s ⋮ shows on hover only, Tab skips it, and a click opens that row’s menu', async () => {
    await renderList();
    const buttons = [...document.querySelectorAll('button[aria-label="More actions"]')];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
        expectKeyboardReveal(button);
        expect(button instanceof HTMLElement && button.tabIndex).toBe(-1);
    }
    await act(async () => {
        if (buttons[1] instanceof HTMLElement) buttons[1].click();
    });
    expect(menuRows()).toEqual(['Menu of Grace']);
});

test('the menu key opens the menu of the row under the cursor, at that row', async () => {
    const container = await renderList('grace');
    const list = container.querySelector('[tabindex="0"]');
    const row = container.querySelectorAll('.eigen-list-item')[1];
    if (!list || !(row instanceof HTMLElement)) throw new Error('no list');
    row.getBoundingClientRect = () => new DOMRect(0, 40, 320, 48);
    const event = new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true });
    await act(async () => {
        list.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(menuRows()).toEqual(['Menu of Grace']);
    const anchor = document.querySelector('[data-slot="dropdown-menu-trigger"]');
    expect(anchor instanceof HTMLElement && [anchor.style.left, anchor.style.top]).toEqual(['320px', '88px']);
});
