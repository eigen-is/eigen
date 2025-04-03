import {createFileRoute, Outlet, redirect} from '@tanstack/react-router'
import {TanStackRouterDevtools} from '@tanstack/react-router-devtools'
import {AuthContextType} from "@workspace/lib/auth/auth-context.tsx";
import {useMediaQuery} from '../hooks/use-media-query';
import {createContext, useState} from 'react';
import {SpaceSidebar} from "@/components/space/space-sidebar.tsx";


// Create a context for sidebar state
export const SidebarContext = createContext<{
    sidebarOpen: boolean;
    setSidebarOpen: (open: boolean) => void;
}>({
    sidebarOpen: false,
    setSidebarOpen: () => {
    },
});

interface MyRouterContext {
    auth: AuthContextType;
}


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
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const isMobile = useMediaQuery('(max-width: 768px)');
    const isTablet = useMediaQuery('(min-width: 769px) and (max-width: 1024px)');

    return (
        <SidebarContext.Provider value={{sidebarOpen, setSidebarOpen}}>

            <div className="flex-1 overflow-hidden">
                <div className="flex flex-1 w-full h-full overflow-hidden">
                    {/* Sidebar: overlay on mobile, normal display on larger screens */}
                    <div
                        className={`
                        ${isMobile ? (sidebarOpen ? 'fixed inset-0 z-50 bg-background' : 'hidden') : 'block'}
                        ${isTablet ? 'w-16' : 'w-64'} 
                        border-r h-full min-h-full
                    `}
                    >
                        <SpaceSidebar
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
            </div>
            <TanStackRouterDevtools position="bottom-right"/>
        </SidebarContext.Provider>
    );
}
