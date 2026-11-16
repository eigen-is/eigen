// The `_auth` route guard of every app with a signed-in area. Its beforeLoad sends a signed-out visitor to /login
// with a way back, and hands the signed-in user to every child route's context, so a page under `_auth` reads a
// user that is always there. Apps with no guest surface, such as Mail, also send a guest out to Drive.

import { Outlet, redirect } from '@tanstack/react-router';
import { getDriveAppUrl } from '@workspace/lib/api';
import type { RouterAppContext } from '@workspace/lib/types/auth';

function AuthOutlet() {
    return <Outlet />;
}

export function createAuthRouteOptions({ redirectGuests = false }: { redirectGuests?: boolean } = {}) {
    return {
        beforeLoad: ({ context, location }: { context: RouterAppContext; location: { href: string } }) => {
            const { user } = context.auth;
            if (!user) {
                // Widened like login-route's `to`: this file compiles in every app's Register,
                // including apps without a /login route of their own (the index app).
                const loginPath: string = '/login';
                throw redirect({
                    to: loginPath,
                    search: {
                        redirect: location.href,
                    },
                });
            }
            if (redirectGuests && user.role === 'guest') {
                window.location.href = getDriveAppUrl();
            }
            return { user };
        },
        component: AuthOutlet,
    };
}
