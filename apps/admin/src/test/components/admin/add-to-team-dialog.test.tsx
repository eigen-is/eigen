// Add to team: the teams load when the dialog opens, and a click on a team hands the selected users to
// one add, which closes the dialog once every user has settled. While it runs, that team's row is busy and
// the other rows wait.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { AdminUserRow } from '@workspace/lib/types/admin';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

// The dialog's two hooks, stubbed: their own test covers the calls to better-auth and the toast of a
// refused add. Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts
// the originals back.
const realAdmin = { ...(await import('@workspace/lib/admin')) };
const teamLoads: string[] = [];
type Add = { teamId: string; userIds: string[] };
const added: Add[] = [];
// The add that is running, if any.
let running: Add | undefined;
const teams = {
    data: [
        { id: 'team-0', name: 'Acme', createdAt: new Date('2026-09-01') },
        { id: 'team-1', name: 'Design', createdAt: new Date('2026-10-01') },
    ],
};
const mutate = (variables: Add, options: { onSettled: () => void }) => {
    added.push(variables);
    options.onSettled();
};
mock.module('@workspace/lib/admin', () => ({
    ...realAdmin,
    useTeams: (organizationId: string) => {
        teamLoads.push(organizationId);
        return teams;
    },
    useAddTeamMembers: () => ({ isPending: running !== undefined, variables: running, mutate }),
}));
// The public config names the default team, which the picker never offers.
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/public', () => ({
    ...realPublic,
    usePublicConfig: () => ({ data: { orgId: 'org-1', defaultTeamId: 'team-0' } }),
}));
afterAll(() => {
    mock.module('@workspace/lib/admin', () => realAdmin);
    mock.module('@workspace/lib/public', () => realPublic);
});

const { act, createElement } = await import('react');
const { AuthProvider } = await import('@workspace/lib/auth');
const { AddToTeamDialog } = await import('../../../components/admin/add-to-team-dialog');

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    running = undefined;
});

const user = (id: string, teams: AdminUserRow['teams'] = []): AdminUserRow => ({
    id,
    name: `User ${id}`,
    email: `${id}@test.eigen.is`,
    memberId: `m-${id}`,
    role: 'member',
    createdAt: new Date('2026-10-01'),
    lastActiveAt: null,
    teams,
});

async function renderDialog(open: boolean, onOpenChange: (open: boolean) => void = () => {}) {
    teamLoads.length = 0;
    added.length = 0;
    ({ unmount } = await renderInDocument(
        createElement(
            AuthProvider,
            null,
            createElement(AddToTeamDialog, {
                open,
                onOpenChange,
                users: [user('u1'), user('u2', [{ id: 'team-1', name: 'Design' }]), user('u3')],
            }),
        ),
    ));
}

test('a closed dialog loads no teams', async () => {
    await renderDialog(false);
    expect(teamLoads).toEqual([]);
});

test('a team click adds the selected users not yet in it in one go, then closes the dialog', async () => {
    const closes: boolean[] = [];
    await renderDialog(true, (open) => closes.push(open));
    expect(teamLoads).toContain('org-1');

    const team = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Design'));
    if (!team) throw new Error('the Design team is not listed');
    await act(async () => team.click());

    expect(added).toEqual([{ teamId: 'team-1', userIds: ['u1', 'u3'] }]);
    expect(closes).toEqual([false]);
});

test('the default team every user joins is not offered', async () => {
    await renderDialog(true);
    const names = [...document.querySelectorAll('button')].map((b) => b.textContent);
    expect(names).toContain('Design');
    expect(names).not.toContain('Acme');
});

test('while an add runs its team row is busy, a click adds nothing more, and the other rows wait', async () => {
    teams.data.push({ id: 'team-2', name: 'Sales', createdAt: new Date('2026-10-02') });
    running = { teamId: 'team-1', userIds: ['u1', 'u3'] };
    await renderDialog(true);
    teams.data.pop();
    const row = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(name));
    expect(row('Design')?.getAttribute('aria-busy')).toBe('true');
    expect(row('Sales')?.disabled).toBe(true);
    await act(async () => row('Design')?.click());
    expect(added).toEqual([]);
});

test('the search field has the focus as the dialog opens', async () => {
    await renderDialog(true);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Search teams');
});
