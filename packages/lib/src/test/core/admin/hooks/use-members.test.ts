import { afterAll, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';

// react-dom needs a DOM to render into.
installHappyDom();

const realAuthClientModule = await import('../../../../core/auth/hooks/use-auth-client');
const realAuthContextModule = await import('../../../../core/auth/auth-context');

type ListMembersQuery = {
    organizationId: string;
    limit?: number;
    offset?: number;
    filterField?: string;
    filterValue?: string;
};
const PAGE = 100;
const TOTAL = 103;
const calls: ListMembersQuery[] = [];
const authCalls: [string, unknown][] = [];
mock.module('../../../../core/auth/hooks/use-auth-client', () => ({
    authClient: {
        admin: {
            createUser: async (body: { email: string }) => {
                authCalls.push(['createUser', body]);
                return { data: { user: { id: 'new-user', email: body.email } }, error: null };
            },
            setRole: async (body: unknown) => {
                authCalls.push(['setRole', body]);
                return { data: {}, error: null };
            },
        },
        organization: {
            updateMemberRole: async (body: unknown) => {
                authCalls.push(['updateMemberRole', body]);
                return { data: {}, error: null };
            },
            listMembers: async ({ query }: { query: ListMembersQuery }) => {
                if (query.filterField === 'userId') {
                    authCalls.push(['listMembers', query]);
                    return {
                        data: { members: [{ id: 'new-member', userId: query.filterValue }], total: 1 },
                        error: null,
                    };
                }
                calls.push(query);
                // better-auth serves 100 rows when no limit is given
                const offset = query.offset ?? 0;
                const limit = query.limit ?? PAGE;
                const members = Array.from({ length: TOTAL }, (_, i) => ({
                    id: `m${i}`,
                    userId: `u${i}`,
                    role: i === 0 ? 'owner' : 'member',
                    createdAt: '2026-09-08T00:00:00.000Z',
                    user: { email: `u${i}@eigen.test`, name: `User ${i}` },
                })).slice(offset, offset + limit);
                return { data: { members, total: TOTAL }, error: null };
            },
        },
    },
}));
mock.module('../../../../core/auth/auth-context', () => ({
    useAuth: () => ({ user: { id: 'u0', role: 'member' } }),
}));

afterAll(() => {
    mock.module('../../../../core/auth/hooks/use-auth-client', () => realAuthClientModule);
    mock.module('../../../../core/auth/auth-context', () => realAuthContextModule);
});

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { useCreateUser, useMembers } = await import('../../../../core/admin/hooks/use-members');

type Result = ReturnType<typeof useMembers>;

function Harness({ onRender }: { onRender: (r: Result) => void }) {
    onRender(useMembers('org1'));
    return null;
}

test('useMembers pages through list-members until every member is loaded', async () => {
    const seen: { latest: Result | null } = { latest: null };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
        root.render(
            createElement(
                QueryClientProvider,
                { client: queryClient },
                createElement(Harness, { onRender: (r) => (seen.latest = r) }),
            ),
        );
    });
    for (let i = 0; i < 50 && !seen.latest?.data; i++) await act(() => new Promise((r) => setTimeout(r, 10)));

    expect(seen.latest?.data?.length).toBe(TOTAL);
    expect(seen.latest?.data?.at(-1)).toMatchObject({ id: 'm102', userId: 'u102', email: 'u102@eigen.test' });
    expect(calls.map((c) => [c.limit, c.offset])).toEqual([
        [PAGE, 0],
        [PAGE, PAGE],
    ]);
    await act(() => root.unmount());
});

test('useCreateUser makes an admin an organization admin the way the Role select does', async () => {
    const seen: { latest: ReturnType<typeof useCreateUser> | null } = { latest: null };
    function CreateHarness() {
        seen.latest = useCreateUser('org1');
        return null;
    }
    const queryClient = new QueryClient();
    const root = createRoot(document.createElement('div'));
    await act(async () => {
        root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(CreateHarness)));
    });
    await act(async () => {
        await seen.latest?.mutateAsync({ name: 'Ada', email: 'ada@eigen.test', password: 'pw', role: 'admin' });
    });

    expect(authCalls).toEqual([
        ['createUser', { name: 'Ada', email: 'ada@eigen.test', password: 'pw' }],
        ['listMembers', { organizationId: 'org1', filterField: 'userId', filterValue: 'new-user' }],
        ['updateMemberRole', { memberId: 'new-member', role: 'admin', organizationId: 'org1' }],
        ['setRole', { userId: 'new-user', role: 'admin' }],
    ]);
    await act(() => root.unmount());
});
