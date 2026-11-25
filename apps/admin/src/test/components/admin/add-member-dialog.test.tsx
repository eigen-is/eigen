// Add member opens on its search, and a click on a user adds that one to the team and clears the search, while the
// dialog stays open for the next. While an add runs, that user's row is busy and the other rows wait.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { OrgMember } from '@workspace/lib/types/admin';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

type Add = { teamId: string; userIds: string[] };
const addMembers = mock((_add: Add) => {});
// The add that is running, if any.
let running: Add | undefined;
// A copy, because mock.module rewrites a loaded module's exports in place, and afterAll puts the original back.
const realAdmin = { ...(await import('@workspace/lib/admin')) };
mock.module('@workspace/lib/admin', () => ({
    ...realAdmin,
    useAddTeamMembers: () => ({ isPending: running !== undefined, variables: running, mutate: addMembers }),
}));
// The avatars read the address book, which this test has no server for.
const realUser = { ...(await import('@workspace/ui/components/user')) };
mock.module('@workspace/ui/components/user', () => ({
    ...realUser,
    UserItem: ({ name }: { name: string }) => name,
}));
afterAll(() => {
    mock.module('@workspace/lib/admin', () => realAdmin);
    mock.module('@workspace/ui/components/user', () => realUser);
});

const { act, createElement } = await import('react');
const { AddMemberDialog } = await import('../../../components/admin/add-member-dialog');

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    addMembers.mockClear();
    running = undefined;
});

const member = (userId: string, name: string): OrgMember => ({
    id: `m-${userId}`,
    userId,
    name,
    email: `${userId}@test.eigen.is`,
    role: 'member',
    createdAt: new Date('2026-10-01'),
});

async function open() {
    ({ unmount } = await renderInDocument(
        createElement(AddMemberDialog, {
            open: true,
            onOpenChange: () => {},
            teamId: 'team-1',
            availableMembers: [member('u2', 'Grace'), member('u1', 'Ada')],
        }),
    ));
}

const search = () => {
    const field = document.querySelector('input[aria-label="Search users"]');
    if (!(field instanceof HTMLInputElement)) throw new Error('no field labelled Search users');
    return field;
};
const row = (name: string) =>
    [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.includes(name));

test('the search has the focus as the dialog opens, and the users are listed by name', async () => {
    await open();
    expect(document.activeElement).toBe(search());
    expect(row('Ada')).toBeDefined();
    expect(row('Grace')).toBeDefined();
});

test('a click adds that user to the team, clears the search and keeps the dialog open', async () => {
    await open();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search(), 'ad');
        search().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(row('Grace')).toBeUndefined();
    await act(async () => row('Ada')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(addMembers.mock.calls).toEqual([[{ teamId: 'team-1', userIds: ['u1'] }]]);
    expect(search().value).toBe('');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});

test('while an add runs its row is busy, a click adds nothing more, and the other rows wait', async () => {
    running = { teamId: 'team-1', userIds: ['u1'] };
    await open();
    const ada = row('Ada');
    const grace = row('Grace');
    if (!(ada instanceof HTMLButtonElement) || !(grace instanceof HTMLButtonElement)) throw new Error('no rows');
    expect(ada.getAttribute('aria-busy')).toBe('true');
    expect(grace.disabled).toBe(true);
    await act(async () => ada.click());
    expect(addMembers).not.toHaveBeenCalled();
});
