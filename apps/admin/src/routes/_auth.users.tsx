import { createFileRoute } from '@tanstack/react-router';
import { useAdminUserList, useAdminUsersUsage } from '@workspace/lib/admin';
import { AdminUsersPage } from '../components/admin/users-page';

type UsersSearch = {
    userId?: string;
};

export const Route = createFileRoute('/_auth/users')({
    component: UsersRoute,
    validateSearch: (search: Record<string, unknown>): UsersSearch => ({
        userId: typeof search.userId === 'string' ? search.userId : undefined,
    }),
});

function UsersRoute() {
    const { userId } = Route.useSearch();
    const { data: users = [], isLoading } = useAdminUserList();
    const { data: usage } = useAdminUsersUsage();
    return <AdminUsersPage users={users} isLoading={isLoading} userId={userId} usage={usage} />;
}
