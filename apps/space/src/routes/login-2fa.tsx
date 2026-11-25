// The two-factor sign-in step, where better-auth sends a user whose password was right. A signed-in visitor goes
// straight on to the page that sent them to sign in, and a redirect that is no page of Eigen's own becomes the start
// page.

import { createFileRoute, redirect } from '@tanstack/react-router';
import { safeRedirect } from '@workspace/lib/api';
import { z } from 'zod';
import { LoginFa2Page } from '../components/space/login-fa2';

const fallback = '/';

export const Route = createFileRoute('/login-2fa')({
    component: LoginFa2Route,
    validateSearch: z.object({
        redirect: z
            .string()
            .optional()
            .catch('')
            .transform((target) => target && safeRedirect(target)),
    }),
    beforeLoad: async ({ context, search }) => {
        if (!context.auth.isAuthenticated) return;
        const target = search.redirect || fallback;
        // A full URL, such as Mail's page that sent the user here, leaves by a page load.
        throw URL.canParse(target) ? redirect({ href: target }) : redirect({ to: target });
    },
});

function LoginFa2Route() {
    return <LoginFa2Page redirect={Route.useSearch().redirect} />;
}
