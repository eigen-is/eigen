import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { getDriveAppUrl } from '@workspace/lib/api';

export const Route = createFileRoute('/_auth')({
    beforeLoad: ({ context, location }) => {
        if (!context.auth.isAuthenticated) {
            throw redirect({
                to: '/login',
                search: {
                    redirect: location.href,
                },
            });
        }
        if (context.auth.user?.role === 'guest') {
            window.location.href = getDriveAppUrl();
            return;
        }
    },
    component: () => <Outlet />,
});
