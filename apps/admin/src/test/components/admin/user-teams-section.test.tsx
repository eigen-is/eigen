// A user's Teams section reads like a team's Members section: a header with the count and the add
// button on the right, then one row per team, or the empty state. The default team every user joins is listed
// with no remove button, and each other team's remove button is named after the team and asks before it removes.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { AdminUserRow } from '@workspace/lib/types/admin';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

// The public config names the default team; stubbed so the section reads it without a server. A copy,
// because mock.module rewrites a loaded module's exports in place, and afterAll puts the original back.
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/public', () => ({
    ...realPublic,
    usePublicConfig: () => ({ data: { orgId: 'org-1', defaultTeamId: 't0' } }),
}));
const removeMember = mock(async (_member: { teamId: string; userId: string }) => {});
const realAdmin = { ...(await import('@workspace/lib/admin')) };
mock.module('@workspace/lib/admin', () => ({
    ...realAdmin,
    useRemoveTeamMember: () => ({ mutateAsync: removeMember, isPending: false }),
}));
afterAll(() => {
    mock.module('@workspace/lib/public', () => realPublic);
    mock.module('@workspace/lib/admin', () => realAdmin);
});
beforeEach(() => removeMember.mockClear());

const { act, createElement } = await import('react');
const { AuthProvider } = await import('@workspace/lib/auth');
const { UserTeamsSection } = await import('../../../components/admin/user-teams-section');

let unmount = async () => {};
afterEach(() => unmount());

const user = (teams: AdminUserRow['teams']): AdminUserRow => ({
    id: 'u1',
    name: 'Ada',
    email: 'ada@test.eigen.is',
    memberId: 'm-u1',
    role: 'member',
    createdAt: new Date('2026-10-01'),
    lastActiveAt: null,
    teams,
});

async function renderSection(teams: AdminUserRow['teams']) {
    let container: HTMLElement;
    ({ container, unmount } = await renderInDocument(
        createElement(AuthProvider, null, createElement(UserTeamsSection, { user: user(teams) })),
    ));
    return container;
}

test('a user in no team shows the count and the empty state', async () => {
    const section = await renderSection([]);
    expect(section.querySelector('h3')?.textContent).toBe('Teams (0)');
    expect(section.querySelector('button')?.textContent).toBe('Add to team');
    expect(section.textContent).toContain('Not in any team yet');
});

test("a user's teams are listed by name under the count", async () => {
    const section = await renderSection([
        { id: 't2', name: 'Sales' },
        { id: 't1', name: 'Design' },
    ]);
    expect(section.querySelector('h3')?.textContent).toBe('Teams (2)');
    expect([...section.querySelectorAll('.divide-y > div')].map((row) => row.textContent)).toEqual(['Design', 'Sales']);
});

test('the default team is listed and counted like any other, with no remove button', async () => {
    const section = await renderSection([
        { id: 't1', name: 'Design' },
        { id: 't0', name: 'Acme' },
    ]);
    expect(section.querySelector('h3')?.textContent).toBe('Teams (2)');
    expect([...section.querySelectorAll('.divide-y > div')].map((row) => row.textContent)).toEqual(['Acme', 'Design']);
    expect(section.querySelector('button[aria-label="Remove from Acme"]')).toBeNull();
    expect(section.querySelector('button[aria-label="Remove from Design"]')).not.toBeNull();

    await unmount();
    const onlyDefault = await renderSection([{ id: 't0', name: 'Acme' }]);
    expect(onlyDefault.querySelector('h3')?.textContent).toBe('Teams (1)');
    expect(onlyDefault.textContent).not.toContain('Not in any team yet');
});

test("each team's remove button is named after the team", async () => {
    const section = await renderSection([
        { id: 't2', name: 'Sales' },
        { id: 't1', name: 'Design' },
    ]);
    expect(section.querySelector('button[aria-label="Remove from Design"]')).not.toBeNull();
    expect(section.querySelector('button[aria-label="Remove from Sales"]')).not.toBeNull();
    expect(section.querySelector('button[aria-label="Remove from team"]')).toBeNull();
});

test('the remove button asks first, and Remove takes the user out of that team', async () => {
    const section = await renderSection([{ id: 't1', name: 'Design' }]);
    await act(async () => section.querySelector<HTMLButtonElement>('button[aria-label="Remove from Design"]')?.click());
    expect(removeMember).not.toHaveBeenCalled();
    const question = document.querySelector('[role="dialog"]');
    expect(question?.querySelector('h2')?.textContent).toBe('Remove from team');
    expect(question?.textContent).toContain('Remove Ada from Design?');

    const remove = [...(question?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Remove');
    await act(async () => remove?.click());
    expect(removeMember.mock.calls).toEqual([[{ teamId: 't1', userId: 'u1' }]]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
});
