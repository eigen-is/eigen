import { afterAll, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';
import { renderHook } from '../../../render-hook';

// react-dom needs a DOM to render the hook into.
installHappyDom();

const realAuthClientModule = await import('../../../../core/auth/hooks/use-auth-client');
const { authClient } = realAuthClientModule;

// better-auth refuses the second user, as it does a user who is no longer in the organization.
const added: string[] = [];
mock.module('../../../../core/auth/hooks/use-auth-client', () => ({
    ...realAuthClientModule,
    authClient: {
        ...authClient,
        organization: {
            ...authClient.organization,
            addTeamMember: async ({ teamId, userId }: { teamId: string; userId: string }) => {
                if (userId === 'u2') return { data: null, error: { message: 'User is not a member' } };
                added.push(`${teamId}:${userId}`);
                return { data: { id: `tm-${userId}` }, error: null };
            },
        },
    },
}));

afterAll(() => {
    mock.module('../../../../core/auth/hooks/use-auth-client', () => realAuthClientModule);
});

const { QueryClient } = await import('@tanstack/react-query');
const { act } = await import('react');
const { wasToasted } = await import('../../../../core/api-error');
const { adminKeys } = await import('../../../../core/admin/hooks/keys');
const { useAddTeamMembers } = await import('../../../../core/admin/hooks/use-teams');

test('adding a selection to a team adds every user it can, reports the one it could not, and refetches once', async () => {
    const queryClient = new QueryClient();
    const invalidated: unknown[][] = [];
    const original = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = (filters, options) => {
        if (filters?.queryKey) invalidated.push([...filters.queryKey]);
        return original(filters, options);
    };
    const { latest, unmount } = await renderHook(() => useAddTeamMembers(), queryClient);

    let failure: unknown = null;
    await act(async () => {
        await latest.mutateAsync({ teamId: 't1', userIds: ['u1', 'u2', 'u3'] }).catch((error) => {
            failure = error;
        });
    });

    expect(added).toEqual(['t1:u1', 't1:u3']);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('User is not a member');
    expect(wasToasted(failure)).toBe(true);
    expect(invalidated.filter((key) => key.join() === adminKeys.users().join())).toHaveLength(1);
    await unmount();
});
