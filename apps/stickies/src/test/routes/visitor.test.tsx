// A visitor is someone without a login who opened a public link. The board route renders for them over the real route
// tree and editor, against a server that answers only the routes a public link opens: read-only, with no share, no
// activity and only the routes on that list asked. A private board sends them to log in with the way back, and a
// signed-in user's and a guest's editor still read the comment index the visitor never asks for.
import { afterAll, expect, mock, test } from 'bun:test';
import { DRIVE_MIME_STICKIES } from '@workspace/lib/types/drive';
import {
    labelled,
    OWNER,
    providers,
    session,
    visitorServer,
    withProviders,
    withSession,
} from '@workspace/ui/test/visitor-server';

const server = visitorServer({ type: 'stickies', mimeType: DRIVE_MIME_STICKIES, name: 'Holiday.eigenstickies' });

const realAuth = { ...(await import('@workspace/lib/auth')) };
const realCollab = { ...(await import('@workspace/lib/collab')) };
mock.module('@workspace/lib/collab', () => withProviders(realCollab));
mock.module('@workspace/lib/auth', () => withSession(realAuth));
afterAll(() => {
    mock.module('@workspace/lib/collab', () => realCollab);
    mock.module('@workspace/lib/auth', () => realAuth);
});

const { routeTree } = await import('../../routeTree.gen');
const open = (url: string) => server.open(routeTree, url);

const URL_OF = (pathId: string) => `/board/${OWNER}/default/${pathId}`;
const READ_ONLY = "You can only read this document because you're set to Viewer";

test('a visitor reads a public board, with its name in the bar, and asks only for what the link opens', async () => {
    const router = await open(URL_OF('pub'));
    expect(router.state.location.pathname).toBe(URL_OF('pub'));
    expect(labelled(READ_ONLY)).not.toBeNull();
    expect(document.querySelector('header')?.textContent).toContain('Holiday');
    expect(labelled('Log in')).not.toBeNull();
    expect(labelled('Share')).toBeNull();
    expect(labelled('Activity')).toBeNull();
    expect(server.outsideTheLink()).toEqual([]);
    // No presence: with no local state y-websocket sends no awareness, and a cursor set later does nothing.
    expect([...providers].map((provider) => provider.awareness.getLocalState())).toEqual([null]);
    // The guard's read, and none from a share dialog.
    expect(server.permissionReads()).toEqual([`/drive/${OWNER}/default/path/pub/permissions`]);
});

test('a visitor lands on login, with the way back, for a board the link does not open', async () => {
    const router = await open(URL_OF('secret'));
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toEqual({ redirect: URL_OF('secret') });
});

test("a signed-in writer's board is editable, offers Share and reads the comment index", async () => {
    session.user = { id: 'bob', email: 'bob@test.eigen.is', name: 'Bob' };
    await open(URL_OF('pub'));
    expect(labelled('Share')).not.toBeNull();
    expect(labelled('Activity')).not.toBeNull();
    expect(server.requested).toContain(`/collab/${OWNER}/default/pub/comments`);
    expect([...providers].every((provider) => provider.awareness.getLocalState() !== null)).toBe(true);
});

test("a guest's board still reads the comment index and the members", async () => {
    session.user = { id: 'guest', email: 'guest@test.eigen.is', name: 'Guest', role: 'guest' };
    await open(URL_OF('pub'));
    expect(labelled(READ_ONLY)).not.toBeNull();
    expect(server.requested).toContain(`/collab/${OWNER}/default/pub/comments`);
    expect(server.requested).toContain(`/drive/${OWNER}/default/path/pub/effective-members`);
});
