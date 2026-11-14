import { expect, test } from 'bun:test';
import { isRedirect } from '@tanstack/react-router';
import type { AuthUser } from '@workspace/lib/types/auth';
import { createAuthRouteOptions } from '../../../../components/layout/pages/auth-route';

const user: AuthUser = {
    id: 'u1',
    email: 'me@test.eigen.is',
    name: 'Me',
    emailVerified: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
};

function beforeLoad(signedIn: AuthUser | null) {
    return createAuthRouteOptions().beforeLoad({
        context: {
            auth: {
                isAuthenticated: signedIn !== null,
                isLoading: false,
                user: signedIn,
                login: async () => ({ success: true }),
                logout: async () => {},
            },
        },
        location: { href: '/fs/u1/default/root' },
    });
}

test('hands the signed-in user to every child route', () => {
    expect(beforeLoad(user)).toEqual({ user });
});

test('sends a signed-out visitor to /login with the page as the way back', () => {
    let thrown: unknown;
    try {
        beforeLoad(null);
    } catch (error) {
        thrown = error;
    }
    if (!isRedirect(thrown)) throw new Error('expected a redirect');
    expect(thrown.options).toMatchObject({ to: '/login', search: { redirect: '/fs/u1/default/root' } });
});
