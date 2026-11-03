// A person list with a menu gives each row a ⋮ button that opens it. A mouse user sees the button on hover only, and
// Tab reaches and shows it, since the list's arrow keys have no way to open the menu.
import { expect, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { expectKeyboardReveal } from '../../hover-reveal';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { createElement } = await import('react');
const { PersonList } = await import('../../../components/user/person-list');

type Person = { id: string; name: string };
const PEOPLE: Person[] = [
    { id: 'ada', name: 'Ada' },
    { id: 'grace', name: 'Grace' },
];

test('each row has a ⋮ button a mouse user sees on hover only, and Tab reaches and shows it', async () => {
    await renderInDocument(
        createElement(PersonList<Person>, {
            items: PEOPLE,
            searchQuery: '',
            getId: (person) => person.id,
            getName: (person) => person.name,
            getSearchFields: (person) => [person.name],
            onRowClick: () => {},
            renderPerson: (person) => createElement('span', null, person.name),
            emptyState: null,
            renderMenuItems: () => null,
        }),
    );
    const buttons = document.querySelectorAll('button[aria-label="More actions"]');
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expectKeyboardReveal(button);
});
