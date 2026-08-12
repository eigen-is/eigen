import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { type RouterAppContext, useAuth } from '@workspace/lib/auth';
import { AppShell } from '@workspace/ui/components/layout/app/app-shell.tsx';
import { SpaceSidebar } from '../components/space/space-sidebar';

function SpaceRoot() {
    const { user } = useAuth();

    return (
        <AppShell
            appName="space"
            rootRoute={Route}
            sidebar={user ? ({ condensed }) => <SpaceSidebar condensed={condensed} /> : undefined}
        >
            <div className="flex-1 overflow-auto">
                <Outlet />
            </div>
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
    component: SpaceRoot,
});
