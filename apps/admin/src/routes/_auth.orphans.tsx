import { createFileRoute } from '@tanstack/react-router';
import { AdminFilteredUserRoute, type AdminFilteredUserSearch } from '../components/admin/admin-filtered-user-route';

export const Route = createFileRoute('/_auth/orphans')({
    component: OrphansRoute,
    validateSearch: (search: Record<string, unknown>): AdminFilteredUserSearch => ({
        userId: typeof search.userId === 'string' ? search.userId : undefined,
    }),
});

function OrphansRoute() {
    const { userId } = Route.useSearch();
    return (
        <AdminFilteredUserRoute
            filter="orphan"
            routeTo="/orphans"
            userId={userId}
            searchPlaceholder="Search orphan users..."
            listEmptyMessage="No orphan users"
            detailEmptyMessage="Select an orphan user to view details"
        />
    );
}
