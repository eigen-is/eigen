import { Outlet, redirect } from '@tanstack/react-router';
import { getDriveAppUrl } from '@workspace/lib/api';

function AuthOutlet() {
    return <Outlet />;
}

// Shared `_auth` guard: bounce anonymous visitors to /login with a return path; when
// `redirectGuests` is set (apps with no guest surface), also bounce guests out to Drive.
export function createAuthRouteOptions({ redirectGuests = false }: { redirectGuests?: boolean } = {}) {
    return {
        beforeLoad: ({
            context,
            location,
        }: {
            context: { auth: { isAuthenticated: boolean; user?: { role?: string | null } | null } };
            location: { href: string };
        }) => {
            if (!context.auth.isAuthenticated) {
                throw redirect({
                    to: '/login',
                    search: {
                        redirect: location.href,
                    },
                });
            }
            if (redirectGuests && context.auth.user?.role === 'guest') {
                window.location.href = getDriveAppUrl();
            }
        },
        component: AuthOutlet,
    };
}
