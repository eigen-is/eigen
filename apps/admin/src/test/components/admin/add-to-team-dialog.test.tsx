// Add to team: the teams load when the dialog opens, and a click adds every selected user, past one
// that better-auth refuses, before the dialog closes.
import { afterEach, expect, test } from 'bun:test';
import type { AdminUserRow } from '@workspace/lib/types/admin';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

// better-auth's client calls fetch, which this stub answers: one team, and a refusal for the second user.
const requests: { path: string; body: unknown }[] = [];
globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        requests.push({ path, body });
        const json = (status: number, data: unknown) =>
            new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
        if (path.endsWith('/organization/list-teams')) {
            return json(200, [{ id: 'team-1', name: 'Design', organizationId: 'org-1', createdAt: '2026-10-01' }]);
        }
        if (path.endsWith('/organization/add-team-member')) {
            return body.userId === 'u2' ? json(400, { message: 'User is not a member' }) : json(200, { id: 'tm' });
        }
        return json(200, null);
    },
    { preconnect: () => {} },
);

const { act, createElement } = await import('react');
const { AuthProvider } = await import('@workspace/lib/auth');
const { AddToTeamDialog } = await import('../../../components/admin/add-to-team-dialog');

let unmount = async () => {};
afterEach(() => unmount());

const user = (id: string): AdminUserRow => ({
    id,
    name: `User ${id}`,
    email: `${id}@test.eigen.is`,
    memberId: `m-${id}`,
    role: 'member',
    createdAt: new Date('2026-10-01'),
    lastActiveAt: null,
    teams: [],
});

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

async function renderDialog(open: boolean, onOpenChange: (open: boolean) => void = () => {}) {
    requests.length = 0;
    ({ unmount } = await renderInDocument(
        createElement(
            AuthProvider,
            null,
            createElement(AddToTeamDialog, {
                open,
                onOpenChange,
                users: [user('u1'), user('u2'), user('u3')],
                organizationId: 'org-1',
            }),
        ),
    ));
    await settle();
}

const teamRequests = () => requests.filter((r) => r.path.endsWith('/organization/list-teams'));

test('a closed dialog loads no teams', async () => {
    await renderDialog(false);
    expect(teamRequests()).toEqual([]);
});

test('a team click adds every user, past one better-auth refuses, then closes the dialog', async () => {
    const closes: boolean[] = [];
    await renderDialog(true, (open) => closes.push(open));
    expect(teamRequests()).toHaveLength(1);

    const team = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Design'));
    if (!team) throw new Error('the Design team is not listed');
    await act(async () => team.click());
    await settle();

    const adds = requests.filter((r) => r.path.endsWith('/organization/add-team-member')).map((r) => r.body);
    expect(adds).toEqual([
        { teamId: 'team-1', userId: 'u1' },
        { teamId: 'team-1', userId: 'u2' },
        { teamId: 'team-1', userId: 'u3' },
    ]);
    expect(closes).toEqual([false]);
});
