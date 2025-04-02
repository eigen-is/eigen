import {createFileRoute} from '@tanstack/react-router'

export const Route = createFileRoute('/')({
    component: HomeComponent,
})

function HomeComponent() {
    const navigate = Route.useNavigate();
    navigate({
        to: '/$filterType/$filterId',
        params: {
            filterType: 'box',
            filterId: 'inbox'
        }
    });

    return null;
}
