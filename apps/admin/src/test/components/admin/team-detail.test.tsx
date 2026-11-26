// A team's detail offers its deletion in the toolbar, except for the organization's default team, which
// every user joins and the server refuses to delete: that team shows no bin, and its detail says why. A delete
// keeps its question busy until the page has left for the teams list.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { NavigateOptions } from '@tanstack/react-router';
import type { OrgTeam } from '@workspace/lib/types/admin';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

// The public config names the default team. The toolbar's navigate after a delete is a spy, and the
// sections below the settings load data of their own, so they render as their names. Copies, because
// mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/public', () => ({
    ...realPublic,
    usePublicConfig: () => ({ data: { orgId: 'org-1', defaultTeamId: 'team-0' } }),
}));
const navigate = mock(async (_options: NavigateOptions) => {});
const realRouter = { ...(await import('@tanstack/react-router')) };
mock.module('@tanstack/react-router', () => ({ ...realRouter, useNavigate: () => navigate }));
const removeTeam = mock(async (_teamId: string) => {});
const realAdmin = { ...(await import('@workspace/lib/admin')) };
mock.module('@workspace/lib/admin', () => ({
    ...realAdmin,
    useRemoveTeam: () => ({ mutateAsync: removeTeam, isPending: false }),
}));
const sections = {
    '../../../components/admin/team-settings-section': 'TeamSettingsSection',
    '../../../components/admin/team-mounts-section': 'TeamMountsSection',
    '../../../components/admin/backup-section': 'BackupSection',
    '../../../components/admin/team-members-section': 'TeamMembersSection',
};
const realSections = new Map<string, Record<string, unknown>>();
for (const [path, name] of Object.entries(sections)) {
    realSections.set(path, { ...(await import(path)) });
    mock.module(path, () => ({ [name]: () => name }));
}
afterAll(() => {
    mock.module('@workspace/lib/public', () => realPublic);
    mock.module('@tanstack/react-router', () => realRouter);
    mock.module('@workspace/lib/admin', () => realAdmin);
    for (const [path, real] of realSections) mock.module(path, () => real);
});

const { act, createElement } = await import('react');
const { TeamDetail, TeamDetailToolbar } = await import('../../../components/admin/team-detail');

let unmount = async () => {};
afterEach(() => unmount());

const team = (id: string, name: string): OrgTeam => ({ id, name, createdAt: new Date('2026-10-01') });
const note = "This is the organization's default team, which every user joins. It can't be deleted.";

async function render(element: Parameters<typeof renderInDocument>[0]) {
    let container: HTMLElement;
    ({ container, unmount } = await renderInDocument(element));
    return container;
}

test('a team an admin made has a delete button and no note', async () => {
    const toolbar = await render(
        createElement(TeamDetailToolbar, { team: team('team-1', 'Design'), organizationId: 'org-1' }),
    );
    expect(toolbar.querySelectorAll('button')).toHaveLength(1);

    await unmount();
    const detail = await render(createElement(TeamDetail, { team: team('team-1', 'Design'), organizationId: 'org-1' }));
    expect(detail.textContent).toContain('TeamMembersSection');
    expect(detail.textContent).not.toContain(note);
});

test('the default team has no delete button, and its detail says it is the default team', async () => {
    const toolbar = await render(
        createElement(TeamDetailToolbar, { team: team('team-0', 'Acme'), organizationId: 'org-1' }),
    );
    expect(toolbar.querySelectorAll('button')).toHaveLength(0);

    await unmount();
    const detail = await render(createElement(TeamDetail, { team: team('team-0', 'Acme'), organizationId: 'org-1' }));
    expect(detail.textContent).toContain(note);
});

test('Delete keeps its question busy until the page has left for the teams list', async () => {
    const { promise: left, resolve: leave } = Promise.withResolvers<void>();
    navigate.mockImplementation(() => left);
    const toolbar = await render(
        createElement(TeamDetailToolbar, { team: team('team-1', 'Design'), organizationId: 'org-1' }),
    );
    await act(async () => toolbar.querySelector('button')?.click());
    const confirm = () =>
        [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) =>
            b.textContent?.includes('Delete'),
        );
    await act(async () => confirm()?.click());
    expect(removeTeam.mock.calls).toEqual([['team-1']]);
    expect(navigate.mock.calls).toEqual([[{ to: '/teams', search: {} }]]);
    expect(confirm()?.getAttribute('aria-busy')).toBe('true');
    await act(async () => leave());
    expect(confirm()).toBeUndefined();
});
