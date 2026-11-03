// The owner's home is the owner's alone: an admin who opens the owner's account sees no Backup section, as they see
// no Reset password and no Delete, while every other account shows it. The owner sees it on their own account.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { AdminUserRow } from '@workspace/lib/types/admin';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

// The signed-in account is the test's to pick. The delete's navigate needs no router here, and the sections load
// data of their own, so they render as their names. Copies, because mock.module rewrites a loaded module's exports
// in place, and afterAll puts the originals back.
let me = { id: 'admin-1' };
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: me }) }));
const realRouter = { ...(await import('@tanstack/react-router')) };
mock.module('@tanstack/react-router', () => ({ ...realRouter, useNavigate: () => () => {} }));
const sections = {
    '../../../components/admin/backup-section': 'BackupSection',
    '../../../components/admin/user-teams-section': 'UserTeamsSection',
};
const realSections = new Map<string, Record<string, unknown>>();
for (const [path, name] of Object.entries(sections)) {
    realSections.set(path, { ...(await import(path)) });
    mock.module(path, () => ({ [name]: () => name }));
}
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@tanstack/react-router', () => realRouter);
    for (const [path, real] of realSections) mock.module(path, () => real);
});

const { createElement } = await import('react');
const { UserDetail } = await import('../../../components/admin/user-detail');

let unmount = async () => {};
afterEach(() => unmount());

const account = (id: string, role: AdminUserRow['role']): AdminUserRow => ({
    id,
    name: 'Ada',
    email: 'ada@test.eigen.is',
    memberId: `m-${id}`,
    role,
    createdAt: new Date('2026-10-01'),
    lastActiveAt: null,
    teams: [],
});

async function renderDetail(user: AdminUserRow) {
    let container: HTMLElement;
    ({ container, unmount } = await renderInDocument(createElement(UserDetail, { user, organizationId: 'org-1' })));
    return container;
}

test("an admin sees no Backup section on the owner's account", async () => {
    me = { id: 'admin-1' };
    const detail = await renderDetail(account('owner-1', 'owner'));
    expect(detail.textContent).toContain('UserTeamsSection');
    expect(detail.textContent).not.toContain('BackupSection');
});

test('an admin sees the Backup section on any other account', async () => {
    me = { id: 'admin-1' };
    for (const role of ['admin', 'member'] as const) {
        const detail = await renderDetail(account('user-1', role));
        expect(detail.textContent).toContain('BackupSection');
        await unmount();
    }
});

test('the owner sees the Backup section on their own account', async () => {
    me = { id: 'owner-1' };
    const detail = await renderDetail(account('owner-1', 'owner'));
    expect(detail.textContent).toContain('BackupSection');
});
