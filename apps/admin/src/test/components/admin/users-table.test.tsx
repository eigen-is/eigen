// The users list sorts by name until a header is clicked: a text column then sorts A to Z, a size or date
// column largest or newest first, and a second click flips it. A search matches a name or an email. An
// account outside the organization says so, and an empty list says whether the search or the server
// left it empty.
import { afterEach, expect, test } from 'bun:test';
import type { AdminUserRow } from '@workspace/lib/types/admin';
import type { HomeSizeResponse } from '@workspace/lib/types/settings';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { AuthProvider } = await import('@workspace/lib/auth');
const { AdminUsersTable } = await import('../../../components/admin/users-table');

const user = (p: Partial<AdminUserRow> & { id: string; name: string; email: string }): AdminUserRow => ({
    memberId: `m-${p.id}`,
    role: 'member',
    createdAt: new Date('2026-10-01'),
    lastActiveAt: null,
    teams: [],
    ...p,
});
const ada = user({ id: 'u1', name: 'Ada Lovelace', email: 'lovelace@test.eigen.is', role: 'owner' });
const grace = user({ id: 'u2', name: 'Grace Hopper', email: 'hopper@test.eigen.is' });
const linus = user({ id: 'u3', name: 'Linus', email: 'torvalds@test.eigen.is', memberId: null, role: null });
const used = (bytes: number): HomeSizeResponse => ({
    homeData: { used: 0, max: 0 },
    drive: { default: { used: bytes, max: 0 } },
    total: { used: bytes, max: 0 },
});
const usage = { u1: used(10), u2: used(3000), u3: used(500) };

let unmount = async () => {};
afterEach(() => unmount());

async function renderTable(props: { users?: AdminUserRow[]; searchQuery?: string; guests?: boolean } = {}) {
    let container: HTMLElement;
    ({ container, unmount } = await renderInDocument(
        createElement(
            AuthProvider,
            null,
            createElement(AdminUsersTable, {
                users: props.users ?? [grace, linus, ada],
                usage,
                searchQuery: props.searchQuery ?? '',
                onRowClick: () => {},
                organizationId: 'org-1',
                guests: props.guests,
            }),
        ),
    ));
    return container;
}

// Each row's name, in the order the list shows them.
const names = (container: HTMLElement) =>
    [...container.querySelectorAll('button.eigen-list-item .truncate.font-medium')].map((cell) => cell.textContent);
const sortBy = (container: HTMLElement, label: string) =>
    act(async () => {
        [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)?.click();
    });

test('the list sorts by name until a header is clicked', async () => {
    const table = await renderTable();
    expect(names(table)).toEqual(['Ada Lovelace', 'Grace Hopper', 'Linus']);
});

test('Disk sorts the largest home first, and a second click the smallest', async () => {
    const table = await renderTable();
    await sortBy(table, 'Disk');
    expect(names(table)).toEqual(['Grace Hopper', 'Linus', 'Ada Lovelace']);
    await sortBy(table, 'Disk');
    expect(names(table)).toEqual(['Ada Lovelace', 'Linus', 'Grace Hopper']);
});

test('Email sorts A to Z by address, not by name', async () => {
    const table = await renderTable();
    await sortBy(table, 'Email');
    expect(names(table)).toEqual(['Grace Hopper', 'Ada Lovelace', 'Linus']);
    await sortBy(table, 'Email');
    expect(names(table)).toEqual(['Linus', 'Ada Lovelace', 'Grace Hopper']);
});

test('a search matches a name or an email, in any case', async () => {
    expect(names(await renderTable({ searchQuery: 'GRACE' }))).toEqual(['Grace Hopper']);
    await unmount();
    expect(names(await renderTable({ searchQuery: 'torvalds' }))).toEqual(['Linus']);
});

test('an account outside the organization says so where its role would be', async () => {
    const table = await renderTable({ users: [linus] });
    expect(table.textContent).toContain('no organization');
});

test('an empty list says whether the search or the server left it empty', async () => {
    expect((await renderTable({ searchQuery: 'nobody' })).textContent).toContain('No users match your search.');
    await unmount();
    expect((await renderTable({ users: [] })).textContent).toContain('No users found');
    await unmount();
    expect((await renderTable({ users: [], guests: true })).textContent).toContain('No guest users');
});
