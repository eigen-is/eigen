import { createFileRoute, Outlet } from '@tanstack/react-router';
import { AppShell } from '@workspace/ui/components/layout/app/app-shell';
import { SupportSidebar } from '../components/support/support-sidebar';

export const Route = createFileRoute('/support')({
    component: SupportLayout,
});

function SupportLayout() {
    return (
        <AppShell
            appName="support"
            rootRoute={Route}
            sidebar={({ condensed, isMobile, onClose }) => (
                <SupportSidebar condensed={condensed} isMobile={isMobile} onClose={onClose} />
            )}
        >
            <Outlet />
        </AppShell>
    );
}
