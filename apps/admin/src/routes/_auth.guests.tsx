import { createFileRoute } from '@tanstack/react-router';
import { AdminFilteredUserRoute, type AdminFilteredUserSearch } from '../components/admin/admin-filtered-user-route';

export const Route = createFileRoute('/_auth/guests')({
    component: GuestsRoute,
    validateSearch: (search: Record<string, unknown>): AdminFilteredUserSearch => ({
        userId: typeof search.userId === 'string' ? search.userId : undefined,
    }),
});

function GuestsRoute() {
    const { userId } = Route.useSearch();
    return (
        <AdminFilteredUserRoute
            filter="guest"
            routeTo="/guests"
            userId={userId}
            searchPlaceholder="Search guests..."
            listEmptyMessage="No guest users"
            detailEmptyMessage="Select a guest to view details"
        />
    );
}
