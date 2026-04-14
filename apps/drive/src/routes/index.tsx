import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
    beforeLoad: ({ context }) => {
        const user = context.auth?.user;
        if (!user) {
            throw redirect({ to: '/login' });
        }
        if (user.role === 'guest') {
            throw redirect({ to: '/shared/$to', params: { to: 'with-me' } });
        }
        throw redirect({
            to: '/fs/$ownerId/$mountId/$pathId',
            params: {
                ownerId: user.id,
                mountId: 'default',
                pathId: 'root',
            },
        });
    },
});
