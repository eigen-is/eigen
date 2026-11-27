// The route guards of every app with a signed-in area. The `_auth` guard's beforeLoad sends a signed-out visitor to
// /login with the page's full URL as the way back, so a sign-in step in another app, such as Space's two-factor step,
// can return to it. It hands the signed-in user to every child route's context, so a page under `_auth` reads a user
// that is always there. Apps with no guest surface, such as Mail, also send a guest out to Drive. The link guard sits
// on the pages a public link opens, such as Drive's folder page, and lets a visitor in only to an item they may read.

import { Outlet, redirect } from '@tanstack/react-router';
import { getDriveAppUrl } from '@workspace/lib/api';
import { fetchPathPermissions } from '@workspace/lib/drive';
import type { RouterAppContext } from '@workspace/lib/types/auth';
import type { DrivePathRef } from '@workspace/lib/types/drive';

function AuthOutlet() {
    return <Outlet />;
}

export function createAuthRouteOptions({ redirectGuests = false }: { redirectGuests?: boolean } = {}) {
    return {
        beforeLoad: ({ context, location }: { context: RouterAppContext; location: { publicHref: string } }) => {
            const { user } = context.auth;
            if (!user) throw redirect(loginLocation(location));
            if (redirectGuests && user.role === 'guest') {
                window.location.href = getDriveAppUrl();
            }
            return { user };
        },
        component: AuthOutlet,
    };
}

// The item is the one the URL names, or null where it names none, such as Drive's root alias. A failed answer, such
// as the 404 of an unknown owner, sends the visitor to log in as a closed item does. TanStack's 'stay' is any
// navigation within the route, another item included: the guard answered on the way in, and the API still refuses an
// item the link does not open.
export async function guardLinkRoute(
    {
        cause,
        context,
        location,
    }: { cause: 'preload' | 'enter' | 'stay'; context: RouterAppContext; location: { publicHref: string } },
    item: DrivePathRef | null,
): Promise<void> {
    if (cause === 'stay' || context.auth.user) return;
    const canRead = item
        ? await fetchPathPermissions(item).then(
              (permissions) => permissions.canRead,
              () => false,
          )
        : false;
    if (!canRead) throw redirect(loginLocation(location));
}

// The login page with the page at `location` as the way back, where a guard, a denial or the top bar sends a visitor.
export function loginLocation(location: { publicHref: string }) {
    // Widened like login-route's `to`: this file compiles in every app's Register,
    // including apps without a /login route of their own (the index app).
    const loginPath: string = '/login';
    // publicHref keeps the app's basepath, which `href` drops.
    return { to: loginPath, search: { redirect: new URL(location.publicHref, window.location.origin).href } };
}
