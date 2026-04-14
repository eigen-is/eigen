import { redirect, useSearch } from '@tanstack/react-router';
import { z } from 'zod';
import { LoginPage } from './loginpage.tsx';

function LoginRoute() {
    const { email } = useSearch({ strict: false }) as { email?: string };
    return <LoginPage email={email} />;
}

export const loginSearchSchema = z.object({
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
