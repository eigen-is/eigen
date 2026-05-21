import { createFileRoute, Outlet } from '@tanstack/react-router';
import { AppShell } from '@workspace/ui/components/layout/app/app-shell';

export const Route = createFileRoute('/blog')({
    component: BlogLayout,
});

function BlogLayout() {
    return (
        <AppShell appName="blog" rootRoute={Route}>
            <Outlet />
        </AppShell>
    );
}
