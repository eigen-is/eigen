import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { ContactsSidebar } from "../../components/contacts/contacts-sidebar.tsx";
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { useContext } from 'react';
import { SidebarContext } from './__root';
import { useMediaQuery } from '../hooks/use-media-query';

// Create a QueryClient instance
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
    const { sidebarOpen, setSidebarOpen } = useContext(SidebarContext);
    const isMobile = useMediaQuery('(max-width: 768px)');
    const isTablet = useMediaQuery('(min-width: 769px) and (max-width: 1024px)');
    
    return (
        <QueryClientProvider client={queryClient}>
            <div className="flex flex-1 w-full h-full overflow-hidden">
                {/* Sidebar: overlay on mobile, normal display on larger screens */}
                <div 
                    className={`
                        ${isMobile ? (sidebarOpen ? 'fixed inset-0 z-50 bg-background' : 'hidden') : 'block'}
                        ${isTablet ? 'w-16' : 'w-64'} 
                        border-r h-full min-h-full
                    `}
                >
                    <ContactsSidebar 
                        condensed={isTablet}
                        isMobile={isMobile}
                        onClose={() => setSidebarOpen(false)}
                    />
                </div>
                
                {/* Backdrop for mobile to close sidebar when clicking outside */}
                {isMobile && sidebarOpen && (
                    <div 
                        className="fixed inset-0 z-40 bg-background/80"
                        onClick={() => setSidebarOpen(false)}
                    />
                )}
                
                {/* Main content area */}
                <main className="flex-1 flex flex-col h-full overflow-auto">
                    <Outlet/>
                </main>
            </div>
            <ReactQueryDevtools initialIsOpen={false} />
        </QueryClientProvider>
    );
}
