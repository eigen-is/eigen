import {createFileRoute, redirect} from '@tanstack/react-router';
import {z} from 'zod'
import {LoginPage} from "@workspace/ui/components/layout/loginpage";

const fallback = '/all';

export const Route = createFileRoute('/login')({
    component: LoginPage,
    validateSearch: z.object({
        redirect: z.string().optional().catch(''),
    }),
    beforeLoad: async ({context, search}) => {
        if (context.auth.isAuthenticated) {
            throw redirect({to: search.redirect || fallback})
        }
    },
});
