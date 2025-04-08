import LoginFa2Page from '../components/space/login-fa2';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';
import { authClient } from '@workspace/lib/auth';

const fallback = '/';

export const Route = createFileRoute('/login-fa2')({
    component: LoginFa2Page,
    validateSearch: z.object({
        redirect: z.string().optional().catch(''),
    }),
    beforeLoad: async ({context, search}) => {
        if (context.auth.isAuthenticated) {
            throw redirect({to: search.redirect || fallback})
        }
    },
});
