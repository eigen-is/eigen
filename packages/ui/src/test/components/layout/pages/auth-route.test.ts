// The `_auth` guard hands the signed-in user to every child route, and sends a signed-out visitor to /login with the
// page they asked for as a full URL, basepath included, so any app's sign-in step can go back to it.
import { expect, test } from 'bun:test';
import type { AuthUser, RouterAppContext } from '@workspace/lib/types/auth';
import { installHappyDom } from '../../../happy-dom';

installHappyDom();

const router = await import('@tanstack/react-router');
const { createAuthRouteOptions } = await import('../../../../components/layout/pages/auth-route');

const user: AuthUser = {
    id: 'u1',
    email: 'me@test.eigen.is',
    name: 'Me',
    emailVerified: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
};

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
        context: {
            auth: {
                isAuthenticated: signedIn !== null,
                isLoading: false,
                user: signedIn,
                login: async () => ({ success: true }),
                logout: async () => {},
            },
        },
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
