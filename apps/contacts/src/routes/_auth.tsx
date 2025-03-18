import {createFileRoute, Outlet, redirect} from '@tanstack/react-router'
import {ContactsSidebar} from "../../components/contacts/contacts-sidebar.tsx";
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'

// Maak een QueryClient instance aan
const queryClient = new QueryClient()

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

    return (
        <QueryClientProvider client={queryClient}>
            <div className="flex flex-1 overflow-hidden">
                <ContactsSidebar/>
                <main className="flex-1 overflow-auto">
                    <Outlet/>
                </main>
            </div>
            <ReactQueryDevtools initialIsOpen={false} />
        </QueryClientProvider>
    );
}
