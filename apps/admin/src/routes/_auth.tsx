import {createFileRoute, Outlet, redirect} from '@tanstack/react-router'
import {AdminSidebar} from "../components/admin/admin-sidebar";
import {useContext} from 'react';
import {SidebarContext} from './__root';
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
            <div
                className={`
                        ${isMobile ? (sidebarOpen ? 'fixed inset-0 z-50 bg-background' : 'hidden') : 'block'}
                        ${isTablet ? 'w-16' : 'w-64'} 
                        border-r h-full min-h-full
                    `}
            >
                <AdminSidebar
                    condensed={isTablet}
                    isMobile={isMobile}
                    onClose={() => setSidebarOpen(false)}
                />
            </div>

            {isMobile && sidebarOpen && (
                <div
                    className="fixed inset-0 z-40 bg-background/80"
                    onClick={() => setSidebarOpen(false)}
                />
            )}

            <main className="flex-1 flex flex-col h-full overflow-auto">
                <Outlet/>
            </main>
        </div>
    );
}
