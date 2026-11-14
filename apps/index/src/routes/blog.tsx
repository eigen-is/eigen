// The layout route of the public site's blog: the app shell, named blog, around the overview and every post.

import { createFileRoute, Outlet } from '@tanstack/react-router';
import { AppShell } from '@workspace/ui/components/layout/app';

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
