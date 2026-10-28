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
            // The server's hook refuses the organization's default team.
            removeTeam: async () => ({
                data: null,
                error: { status: 403, message: "The organization's default team can't be deleted" },
            }),
        },
    },
}));

afterAll(() => {
    mock.module('../../../../core/auth/hooks/use-auth-client', () => realAuthClientModule);
});

const { QueryClient } = await import('@tanstack/react-query');
const { act } = await import('react');
const { getErrorMessage, isRefusal, wasToasted } = await import('../../../../core/api-error');
const { adminKeys } = await import('../../../../core/admin/hooks/keys');
const { useAddTeamMembers, useRemoveTeam } = await import('../../../../core/admin/hooks/use-teams');

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

// The delete dialog closes on a refusal, so the error keeps the status the server refused with.
test("a team the server won't delete fails as a refusal with the server's message", async () => {
    const { latest, unmount } = await renderHook(() => useRemoveTeam('org'), new QueryClient());

    let failure: unknown = null;
    await act(async () => {
        await latest.mutateAsync('t1').catch((error) => {
            failure = error;
        });
    });

    expect(isRefusal(failure)).toBe(true);
    expect(getErrorMessage(failure)).toBe("The organization's default team can't be deleted (403)");
    expect(wasToasted(failure)).toBe(true);
    await unmount();
});
