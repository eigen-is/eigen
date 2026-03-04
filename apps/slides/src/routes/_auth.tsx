import {createFileRoute, Outlet, redirect} from '@tanstack/react-router';

export const Route = createFileRoute('/_auth')({
    beforeLoad: ({context}) => {
        if (!context.auth.isAuthenticated) {
            throw redirect({to: '/login'});
        }
    },
    component: () => <Outlet/>,
});
