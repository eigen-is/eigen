// The two-factor sign-in step, where better-auth sends a user whose password was right. A signed-in visitor goes
// straight on to the page that sent them to sign in.

import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';
import { LoginFa2Page } from '../components/space/login-fa2';

const fallback = '/';

export const Route = createFileRoute('/login-2fa')({
    component: LoginFa2Route,
    validateSearch: z.object({
        redirect: z.string().optional().catch(''),
    }),
    beforeLoad: async ({ context, search }) => {
        if (context.auth.isAuthenticated) {
            throw redirect({ to: search.redirect || fallback });
        }
    },
});

function LoginFa2Route() {
    return <LoginFa2Page redirect={Route.useSearch().redirect} />;
}
