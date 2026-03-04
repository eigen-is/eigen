import {createFileRoute, redirect} from '@tanstack/react-router'

export const Route = createFileRoute('/')({
    beforeLoad: ({context}) => {
        if (!context.auth?.user?.id) {
            throw redirect({to: '/login'});
        }
        throw redirect({
            to: '/mime/$mimeType',
            params: {
                mimeType: 'application-eigensheet'
            }
        });
    },
})
