// A team's Members section gives each member a remove button named after them, so a screen reader hears whom it
// removes. The organization's default team, which every user joins, is the exception: there nobody can be removed,
// so no row has the button. The button asks before it removes anyone.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { OrgTeam } from '@workspace/lib/types/admin';
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
    useTeamMembers: () => ({
        data: [
            { userId: 'u1', name: 'Ada', email: 'ada@test.eigen.is' },
            { userId: 'u2', name: '', email: 'nameless@test.eigen.is' },
        ],
    }),
}));
const removeMember = mock(async (_member: { teamId: string; userId: string }) => {});
const realAdmin = { ...(await import('@workspace/lib/admin')) };
mock.module('@workspace/lib/admin', () => ({
    ...realAdmin,
    useMembers: () => ({ data: [] }),
    useRemoveTeamMember: () => ({ mutateAsync: removeMember, isPending: false }),
}));
afterAll(() => {
    mock.module('@workspace/lib/public', () => realPublic);
    mock.module('@workspace/lib/team', () => realTeam);
    mock.module('@workspace/lib/admin', () => realAdmin);
});

const { act, createElement } = await import('react');
const { AuthProvider } = await import('@workspace/lib/auth');
const { TeamMembersSection } = await import('../../../components/admin/team-members-section');

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => removeMember.mockClear());

async function render(teamId: string) {
    const team: OrgTeam = { id: teamId, name: 'Design', createdAt: new Date('2026-10-01') };
    let container: HTMLElement;
    ({ container, unmount } = await renderInDocument(
        createElement(AuthProvider, null, createElement(TeamMembersSection, { team, organizationId: 'org-1' })),
    ));
    return container;
}

// The Add button is the only other button in the section.
const removeButtons = (section: HTMLElement) => section.querySelectorAll('button').length - 1;

const buttonNamed = (section: HTMLElement, name: string) => section.querySelector(`button[aria-label="${name}"]`);

test('a team an admin made has a remove button on each member, named after the name or email the row shows', async () => {
    const section = await render('team-1');
    expect(section.textContent).toContain('Ada');
    expect(removeButtons(section)).toBe(2);
    expect(buttonNamed(section, 'Remove Ada from team')).not.toBeNull();
    expect(buttonNamed(section, 'Remove nameless@test.eigen.is from team')).not.toBeNull();
    expect(buttonNamed(section, 'Remove from team')).toBeNull();
});

test('the default team has no remove button on any member', async () => {
    const section = await render('team-0');
    expect(section.textContent).toContain('Ada');
    expect(removeButtons(section)).toBe(0);
});

test('the remove button asks first, and Remove takes the member out of the team', async () => {
    const section = await render('team-1');
    await act(async () =>
        buttonNamed(section, 'Remove Ada from team')?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(removeMember).not.toHaveBeenCalled();
    const question = document.querySelector('[role="dialog"]');
    expect(question?.querySelector('h2')?.textContent).toBe('Remove from team');
    expect(question?.textContent).toContain('Remove Ada from Design?');

    const remove = [...(question?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Remove');
    await act(async () => remove?.click());
    expect(removeMember.mock.calls).toEqual([[{ teamId: 'team-1', userId: 'u1' }]]);
});
