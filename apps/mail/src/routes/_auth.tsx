import {createFileRoute, Outlet, redirect} from '@tanstack/react-router'
import {EmailSidebar} from "../components/mail/email-sidebar.tsx";
import {useContext} from 'react';
import {SidebarContext} from './__root';
import {useMailboxes} from '@workspace/lib/mail';
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
    // const isDesktop = useMediaQuery('(min-width: 1025px)');

    const {data: mailboxes = [], isLoading: isMailboxesLoading, error: isMailboxesError} = useMailboxes();

    return (
        <div className="flex flex-1 w-full h-full overflow-hidden">
            {/* Sidebar: First column - always visible on desktop/tablet, overlay on mobile */}
            <div
                className={`
                        ${isMobile ? (sidebarOpen ? 'fixed inset-0 z-50 bg-background' : 'hidden') : 'block'}
                        ${isTablet ? 'w-16' : 'w-64'} 
                        border-r h-full min-h-full
                    `}
            >
                <EmailSidebar
                    condensed={isTablet}
                    isMobile={isMobile}
                    onClose={() => setSidebarOpen(false)}
                    mailboxes={mailboxes}
                    isLoading={isMailboxesLoading}
                    error={isMailboxesError}
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
    );
}
