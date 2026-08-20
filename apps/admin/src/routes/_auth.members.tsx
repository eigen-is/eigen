import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_auth/members')({
    beforeLoad: () => {
        throw redirect({ to: '/users' });
    },
});
