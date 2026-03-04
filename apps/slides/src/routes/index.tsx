import {createFileRoute, redirect} from '@tanstack/react-router';

export const Route = createFileRoute('/')({
    beforeLoad: () => {
        throw redirect({to: '/mime/$mimeType', params: {mimeType: 'application-eigenslides'}});
    },
});
