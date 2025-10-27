import {createFileRoute} from '@tanstack/react-router'
import {useAuth} from '@workspace/lib/auth';

export const Route = createFileRoute('/')({
    component: HomeComponent,
})

function HomeComponent() {
    const navigate = Route.useNavigate();
    const {user} = useAuth();

    if (!user || !user.id) {
        navigate({
            to: '/login'
        });
    } else {
        navigate({
            to: '/fs/$ownerId/$pathId',
            params: {
                ownerId: user.id,
                pathId: 'root'
            }
        });
    }

    return null;
}
