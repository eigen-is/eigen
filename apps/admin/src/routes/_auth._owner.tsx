import { createFileRoute, Outlet } from '@tanstack/react-router';
import { useIsOrgOwner } from '@workspace/lib/admin';
import { EmptyState } from '@workspace/ui';

// Settings, onboarding and guest access are the owner's; _auth has already let admins in and loaded the members.
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
