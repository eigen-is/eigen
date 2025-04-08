import LoginFa2Page from '../components/space/login-fa2';
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router';
import { z } from 'zod';
import { authClient } from '@workspace/lib/auth';

const fallback = '/login';

export const Route = createFileRoute('/login-2fa')({
    component: LoginFa2Page,
    validateSearch: z.object({
        redirect: z.string().optional().catch(''),
    }),
    beforeLoad: async ({context, search}) => {
        if (context.auth.isAuthenticated ) {
            throw redirect({to: search.redirect || fallback})
        }
    },
});
