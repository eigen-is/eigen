// The /login route every app builds from createLoginRouteOptions: it sends a visitor who already has a session on to
// the page that asked for sign-in, and shows everyone else LoginPage. A guest's address, such as one from a share
// invite, comes along in the search, either as its own param or inside the redirect URL, and opens the Guest tab.

import { redirect, useSearch } from '@tanstack/react-router';
import { z } from 'zod';
import { LoginPage } from './login-page';

function LoginRoute() {
    const search = useSearch({ strict: false });
    const email =
        search.email ||
        (search.redirect?.includes('email=') ? new URLSearchParams(search.redirect.split('?')[1]).get('email') : null);
    return <LoginPage email={email || undefined} />;
}

const loginSearchSchema = z.object({
    redirect: z.string().optional().catch(''),
    email: z.string().optional().catch(''),
});

export function createLoginRouteOptions(fallback = '/') {
    return {
        component: LoginRoute,
        validateSearch: loginSearchSchema,
        beforeLoad: async ({
            context,
            search,
        }: {
            context: { auth: { isAuthenticated: boolean } };
            search: { redirect?: string; email?: string };
        }) => {
            if (context.auth.isAuthenticated) {
                throw redirect({ to: search.redirect || fallback });
            }
        },
    };
}
