import { createFileRoute, redirect } from '@tanstack/react-router';

// Legacy path: the members page moved to /users. Carry its ?userId= through so a bookmarked
// deep link still lands on the right user detail after the redirect.
export const Route = createFileRoute('/_auth/members')({
    validateSearch: (search: Record<string, unknown>): { userId?: string } => ({
        userId: typeof search.userId === 'string' ? search.userId : undefined,
    }),
    beforeLoad: () => {
        throw redirect({ to: '/users', search: (prev) => prev });
    },
});
