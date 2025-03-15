import {createFileRoute, Outlet, redirect} from '@tanstack/react-router'
import {AppSidebar} from "../../components/mail/app-sidebar.tsx";

export const Route = createFileRoute('/_auth')({
    beforeLoad: ({context, location}) => {
        if (!context.auth.isAuthenticated) {
            throw redirect({
                to: '/login',
                search: {
                    redirect: location.href,
                },
            })
        }
    },
    component: AuthLayout,
})

function AuthLayout() {
    // const router = useRouter();
    // const navigate = Route.useNavigate();
    // const auth = useAuth();

    return <div className="flex flex-1 overflow-hidden">
        <AppSidebar/>
        <main className="flex-1 overflow-auto">
            <Outlet/>
        </main>
    </div>;
}
