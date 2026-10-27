// A user's Teams section reads like a team's Members section: a header with the count and the add
// button on the right, then one row per team, or the empty state.
import { afterEach, expect, test } from 'bun:test';
import type { AdminUserRow } from '@workspace/lib/types/admin';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { createElement } = await import('react');
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
        createElement(
            AuthProvider,
            null,
            createElement(UserTeamsSection, { user: user(teams), organizationId: 'org-1' }),
        ),
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
