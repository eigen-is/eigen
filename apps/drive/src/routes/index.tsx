import {createFileRoute, redirect} from '@tanstack/react-router'

export const Route = createFileRoute('/')({
    beforeLoad: ({context}) => {
        const userId = context.auth?.user?.id;
        if (!userId) {
            throw redirect({to: '/login'});
        }
        throw redirect({
            to: '/fs/$ownerId/$pathId',
            params: {
                ownerId: userId,
                pathId: 'root'
            }
        });
    },
})
