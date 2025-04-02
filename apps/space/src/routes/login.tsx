import {createFileRoute, redirect} from '@tanstack/react-router';
import {z} from 'zod'
import {LoginPage} from "@workspace/ui/components/layout/loginpage";

const fallback = '/';

export const Route = createFileRoute('/login')({
    component: () => <LoginPage appName="space"/>,
    validateSearch: z.object({
        redirect: z.string().optional().catch(''),
    }),
    beforeLoad: async ({context, search}) => {
        if (context.auth.isAuthenticated) {
            throw redirect({to: search.redirect || fallback})
        }
    },
});
