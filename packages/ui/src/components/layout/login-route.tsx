import {redirect} from '@tanstack/react-router'
import {z} from 'zod'
import {LoginPage} from './loginpage'

export const loginSearchSchema = z.object({
    redirect: z.string().optional().catch(''),
});

export function createLoginRouteOptions(fallback = '/') {
    return {
        component: () => <LoginPage/>,
        validateSearch: loginSearchSchema,
        beforeLoad: async ({context, search}: {
            context: { auth: { isAuthenticated: boolean } },
            search: { redirect?: string }
        }) => {
            if (context.auth.isAuthenticated) {
                throw redirect({to: search.redirect || fallback})
            }
        },
    }
}
