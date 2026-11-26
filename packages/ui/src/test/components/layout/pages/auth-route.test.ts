import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isRedirect } from '@tanstack/react-router';
import type { AuthUser, RouterAppContext } from '@workspace/lib/types/auth';
import type { DrivePathRef } from '@workspace/lib/types/drive';
import { createAuthRouteOptions, guardLinkRoute } from '../../../../components/layout/pages/auth-route';

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

function beforeLoad(signedIn: AuthUser | null) {
    return createAuthRouteOptions().beforeLoad({
        context: contextOf(signedIn),
        location: { href: '/fs/u1/default/root' },
    });
}

async function thrownBy(run: () => unknown): Promise<unknown> {
    try {
        await run();
    } catch (error) {
        return error;
    }
    return undefined;
}

test('hands the signed-in user to every child route', () => {
    expect(beforeLoad(user)).toEqual({ user });
});

test('sends a signed-out visitor to /login with the page as the way back', async () => {
    const thrown = await thrownBy(() => beforeLoad(null));
    if (!isRedirect(thrown)) throw new Error('expected a redirect');
    expect(thrown.options).toMatchObject({ to: '/login', search: { redirect: '/fs/u1/default/root' } });
});

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
    const location = { href: '/shared/with-me?pid=report&uid=alice' };
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
        if (!isRedirect(thrown)) throw new Error('expected a redirect');
        expect(thrown.options).toMatchObject({ to: '/login', search: { redirect: location.href } });
    });

    test('a visitor goes to /login at once on a URL that names no item', async () => {
        const thrown = await thrownBy(() => guard(null, null));
        if (!isRedirect(thrown)) throw new Error('expected a redirect');
        expect(thrown.options).toMatchObject({ to: '/login', search: { redirect: location.href } });
        expect(asked).toEqual([]);
    });

    test('a visitor goes to /login when the permissions route refuses, such as for an unknown owner', async () => {
        g.fetch = async () => Response.json({ message: 'Not found' }, { status: 404 });
        expect(isRedirect(await thrownBy(() => guard(null, item)))).toBe(true);
    });
});
