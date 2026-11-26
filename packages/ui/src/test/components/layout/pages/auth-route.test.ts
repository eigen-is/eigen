// The `_auth` guard hands the signed-in user to every child route, and sends a signed-out visitor to /login with the
// page they asked for as a full URL, basepath included, so any app's sign-in step can go back to it. The link guard
// lets a visitor into a page a public link opens only when the item it names is one they may read.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AuthUser, RouterAppContext } from '@workspace/lib/types/auth';
import type { DrivePathRef } from '@workspace/lib/types/drive';
import { installHappyDom } from '../../../happy-dom';

installHappyDom();

const router = await import('@tanstack/react-router');
const { createAuthRouteOptions, guardLinkRoute } = await import('../../../../components/layout/pages/auth-route');

const user: AuthUser = {
    id: 'u1',
    email: 'me@test.eigen.is',
    name: 'Me',
    emailVerified: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
};

function contextOf(signedIn: AuthUser | null): RouterAppContext {
    return {
        auth: {
            isAuthenticated: signedIn !== null,
            isLoading: false,
            user: signedIn,
            login: async () => ({ success: true }),
            logout: async () => {},
        },
    };
}

// Mail's routes under its basepath: the guarded inbox and the /login it sends a stranger to.
async function openMail(path: string, signedIn: AuthUser | null) {
    const root = router.createRootRouteWithContext<RouterAppContext>()();
    const auth = router.createRoute({ getParentRoute: () => root, id: '_auth', ...createAuthRouteOptions() });
    const inbox = router.createRoute({ getParentRoute: () => auth, path: '/box/inbox' });
    const login = router.createRoute({ getParentRoute: () => root, path: '/login' });
    const mail = router.createRouter({
        routeTree: root.addChildren([auth.addChildren([inbox]), login]),
        basepath: '/mail',
        history: router.createMemoryHistory({ initialEntries: [path] }),
        context: contextOf(signedIn),
    });
    await mail.load();
    return mail.state.location;
}

test('hands the signed-in user to every child route', async () => {
    expect((await openMail('/mail/box/inbox', user)).pathname).toBe('/box/inbox');
});

test('sends a signed-out visitor to /login with the full URL of the page as the way back', async () => {
    const location = await openMail('/mail/box/inbox?page=2', null);
    expect(location.pathname).toBe('/login');
    expect(location.search).toEqual({ redirect: 'http://localhost:3000/mail/box/inbox?page=2' });
});

async function thrownBy(run: () => unknown): Promise<unknown> {
    try {
        await run();
    } catch (error) {
        return error;
    }
    return undefined;
}

// A route a public link opens lets a visitor in only to an item the permissions route says they may read.
describe('guardLinkRoute', () => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
    const g = globalThis as any;
    const realFetch = g.fetch;
    const asked: string[] = [];
    const answer = { canRead: true };

    beforeEach(() => {
        asked.length = 0;
        answer.canRead = true;
        g.fetch = async (url: string) => {
            asked.push(new URL(url).pathname);
            return Response.json({ canRead: answer.canRead, canWrite: false });
        };
    });
    afterEach(() => {
        g.fetch = realFetch;
    });

    const item: DrivePathRef = { ownerId: 'alice', mountId: 'default', pathId: 'report' };
    const location = { publicHref: '/shared/with-me?pid=report&uid=alice' };
    const wayBack = 'http://localhost:3000/shared/with-me?pid=report&uid=alice';
    const guard = (signedIn: AuthUser | null, target: DrivePathRef | null) =>
        guardLinkRoute(contextOf(signedIn), location, target);

    test('a signed-in user passes without a request', async () => {
        await guard(user, item);
        await guard(user, null);
        expect(asked).toEqual([]);
    });

    test('a visitor passes to a readable item, after asking its permissions', async () => {
        await guard(null, item);
        expect(asked).toEqual(['/drive/alice/default/path/report/permissions']);
    });

    test('a visitor goes to /login with the way back on an item they may not read', async () => {
        answer.canRead = false;
        const thrown = await thrownBy(() => guard(null, item));
        if (!router.isRedirect(thrown)) throw new Error('expected a redirect');
        expect(thrown.options).toMatchObject({ to: '/login', search: { redirect: wayBack } });
    });

    test('a visitor goes to /login at once on a URL that names no item', async () => {
        const thrown = await thrownBy(() => guard(null, null));
        if (!router.isRedirect(thrown)) throw new Error('expected a redirect');
        expect(thrown.options).toMatchObject({ to: '/login', search: { redirect: wayBack } });
        expect(asked).toEqual([]);
    });

    test('a visitor goes to /login when the permissions route refuses, such as for an unknown owner', async () => {
        g.fetch = async () => Response.json({ message: 'Not found' }, { status: 404 });
        expect(router.isRedirect(await thrownBy(() => guard(null, item)))).toBe(true);
    });
});
