import {createFileRoute, redirect} from '@tanstack/react-router'

export const Route = createFileRoute('/')({
    beforeLoad: () => {
        throw redirect({
            to: '/$filterType/$filterId',
            params: {
                filterType: 'box',
                filterId: 'inbox'
            }
        });
    },
})
