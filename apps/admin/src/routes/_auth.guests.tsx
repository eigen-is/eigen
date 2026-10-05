import { createFileRoute } from '@tanstack/react-router';
import { useAdminGuests } from '@workspace/lib/admin';
import { AdminUsersPage } from '../components/admin/users-page';

type GuestsSearch = { userId?: string };

export const Route = createFileRoute('/_auth/guests')({
    component: GuestsRoute,
    validateSearch: (search: Record<string, unknown>): GuestsSearch => ({
        userId: typeof search.userId === 'string' ? search.userId : undefined,
    }),
});

function GuestsRoute() {
    const { userId } = Route.useSearch();
    const { data: guests = [], isLoading } = useAdminGuests();
    return <AdminUsersPage users={guests} isLoading={isLoading} userId={userId} guests />;
}
