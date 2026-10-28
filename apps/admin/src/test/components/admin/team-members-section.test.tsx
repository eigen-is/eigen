// A team's Members section gives each member a "Remove from team" button, except on the organization's
// default team, which every user joins: there nobody can be removed, so no row has the button.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

// The members and the public config are stubbed so the section needs no server. Copies, because
// mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/public', () => ({
    ...realPublic,
    usePublicConfig: () => ({ data: { orgId: 'org-1', defaultTeamId: 'team-0' } }),
}));
const realTeam = { ...(await import('@workspace/lib/team')) };
mock.module('@workspace/lib/team', () => ({
    ...realTeam,
    useTeamMembers: () => ({ data: [{ userId: 'u1', name: 'Ada', email: 'ada@test.eigen.is' }] }),
}));
const realAdmin = { ...(await import('@workspace/lib/admin')) };
mock.module('@workspace/lib/admin', () => ({
    ...realAdmin,
    useMembers: () => ({ data: [] }),
    useAddTeamMembers: () => ({ mutate: () => {} }),
    useRemoveTeamMember: () => ({ mutate: () => {} }),
}));
afterAll(() => {
    mock.module('@workspace/lib/public', () => realPublic);
    mock.module('@workspace/lib/team', () => realTeam);
    mock.module('@workspace/lib/admin', () => realAdmin);
});

const { createElement } = await import('react');
const { AuthProvider } = await import('@workspace/lib/auth');
const { TeamMembersSection } = await import('../../../components/admin/team-members-section');

let unmount = async () => {};
afterEach(() => unmount());

async function render(teamId: string) {
    let container: HTMLElement;
    ({ container, unmount } = await renderInDocument(
        createElement(AuthProvider, null, createElement(TeamMembersSection, { teamId })),
    ));
    return container;
}

// The Add button is the only other button in the section.
const removeButtons = (section: HTMLElement) => section.querySelectorAll('button').length - 1;

test('a team an admin made has a remove button on each member', async () => {
    const section = await render('team-1');
    expect(section.textContent).toContain('Ada');
    expect(removeButtons(section)).toBe(1);
});

test('the default team has no remove button on any member', async () => {
    const section = await render('team-0');
    expect(section.textContent).toContain('Ada');
    expect(removeButtons(section)).toBe(0);
});
