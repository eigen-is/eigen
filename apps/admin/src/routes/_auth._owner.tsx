// The guard around the admin pages only the server's owner may open, such as Settings and Guest access. The
// signed-in area above it has already let admins in, so an admin who is not the owner gets a notice here in
// place of the page.

import { createFileRoute, Outlet } from '@tanstack/react-router';
import { useIsOrgOwner } from '@workspace/lib/admin';
import { EmptyState } from '@workspace/ui/components/layout/app';

export const Route = createFileRoute('/_auth/_owner')({
    component: OwnerGuard,
});

function OwnerGuard() {
    const isOwner = useIsOrgOwner();

    if (!isOwner) {
        return <EmptyState message="Only the server owner can open this page." />;
    }

    return <Outlet />;
}
