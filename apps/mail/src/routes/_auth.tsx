import {createFileRoute, Outlet, redirect} from '@tanstack/react-router'
import {AppSidebar} from "../components/mail/app-sidebar.tsx";
import {useContext} from 'react';
import {SidebarContext} from './__root';
import {useMediaQuery} from '../hooks/use-media-query';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {ReactQueryDevtools} from '@tanstack/react-query-devtools';

// Create a QueryClient instance
const queryClient = new QueryClient();

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
    const isDesktop = useMediaQuery('(min-width: 1025px)');
    
    return (
        <QueryClientProvider client={queryClient}>
            <div className="flex flex-1 w-full h-full overflow-hidden">
                {/* Sidebar: First column - always visible on desktop/tablet, overlay on mobile */}
                <div 
                    className={`
                        ${isMobile ? (sidebarOpen ? 'fixed inset-0 z-50 bg-background' : 'hidden') : 'block'}
                        ${isTablet ? 'w-16' : 'w-64'} 
                        border-r h-full min-h-full
                    `}
                >
                    <AppSidebar 
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
                
                {/* Main content area - contains columns 2 and 3 */}
                <main className="flex-1 flex h-full overflow-hidden">
                    <Outlet/>
                </main>
            </div>
            <ReactQueryDevtools initialIsOpen={false} />
        </QueryClientProvider>
    );
}
