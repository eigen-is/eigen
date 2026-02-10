import {createFileRoute, Outlet, redirect} from '@tanstack/react-router'
import {useContext} from 'react';
import {SidebarContext} from './__root';
import {SpaceSidebar} from "../components/space/space-sidebar";
import {useIsMobile, useIsTablet} from "@workspace/lib/media";


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
    const {sidebarOpen, setSidebarOpen} = useContext(SidebarContext);
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();

    return (
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
            <main className="flex-1 flex flex-col h-full overflow-hidden">
                <Outlet/>
            </main>
        </div>
    );
}
