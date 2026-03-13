import {createFileRoute, redirect} from '@tanstack/react-router'

export const Route = createFileRoute('/')({
    beforeLoad: ({context}) => {
        if (context.auth.isAuthenticated) {
            throw redirect({to: '/view'} as any);
        } else {
            throw redirect({to: '/login'});
        }
    },
})
