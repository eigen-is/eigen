import { redirect, useSearch } from '@tanstack/react-router';
import { z } from 'zod';
import { LoginPage } from './login-page';

function LoginRoute() {
    const search = useSearch({ strict: false }) as { email?: string; redirect?: string };
    // email may be a top-level param or embedded inside the redirect URL
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
