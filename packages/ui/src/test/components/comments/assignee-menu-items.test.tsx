// Assign to is a choice: a submenu of Me, Unassigned and the members, the assignee checked.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { checkRows, clickRow, menuRows, openSubmenu, renderOpenMenu } from '../../menu-rows';

installHappyDom();

const realPublic = await import('@workspace/lib/public');
mock.module('@workspace/lib/public', () => ({
    ...realPublic,
    usePublicUsers: () => ({ 'olivia@example.com': { name: 'Olivia' } }),
}));
// The avatar's initial would read into the row's name.
mock.module('../../../components/comments/member-avatar', () => ({ MemberAvatar: () => null }));

const { createElement } = await import('react');
const { AssigneeMenuItems } = await import('../../../components/comments/assignee-menu-items');

let unmount = async () => {};
afterEach(() => unmount());

const members = [
    { email: 'me@example.com', read: true, write: true },
    { email: 'olivia@example.com', read: true, write: true },
];

async function render(assignee: string | null, onAssign = (_email: string | null) => {}) {
    ({ unmount } = await renderOpenMenu(
        createElement(AssigneeMenuItems, { members, currentUserEmail: 'me@example.com', assignee, onAssign }),
    ));
    expect(menuRows()).toEqual(['Assign to']);
    await openSubmenu('Assign to');
}

test('the assignee is checked, the current user pinned as Me', async () => {
    await render('olivia@example.com');
    expect(checkRows()).toEqual([
        ['Me', 'false'],
        ['Unassigned', 'false'],
        ['Olivia', 'true'],
    ]);
});

test('an unassigned card checks Unassigned, and Me assigns the current user', async () => {
    const onAssign = mock((_email: string | null) => {});
    await render(null, onAssign);
    expect(checkRows().filter(([, checked]) => checked === 'true')).toEqual([['Unassigned', 'true']]);
    await clickRow('Me');
    expect(onAssign.mock.calls).toEqual([['me@example.com']]);
});
