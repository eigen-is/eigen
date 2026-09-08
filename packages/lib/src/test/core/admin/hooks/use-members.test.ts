import { afterAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';

// react-dom needs a DOM to render into; the globals are removed again in afterAll so later test
// files see the plain bun environment. Recipe: the use-collab-doc test.
const window = new Window({ url: 'http://localhost:3000' });
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.window = window;
g.document = window.document;
g.navigator = window.navigator;
g.IS_REACT_ACT_ENVIRONMENT = true;

const realAuthClientModule = await import('../../../../core/auth/hooks/use-auth-client');
const realAuthContextModule = await import('../../../../core/auth/auth-context');

type ListMembersQuery = { organizationId: string; limit?: number; offset?: number };
const PAGE = 100;
const TOTAL = 103;
const calls: ListMembersQuery[] = [];
mock.module('../../../../core/auth/hooks/use-auth-client', () => ({
    authClient: {
        organization: {
            listMembers: async ({ query }: { query: ListMembersQuery }) => {
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
    g.window = undefined;
    g.document = undefined;
    g.navigator = undefined;
    g.IS_REACT_ACT_ENVIRONMENT = undefined;
    mock.module('../../../../core/auth/hooks/use-auth-client', () => realAuthClientModule);
    mock.module('../../../../core/auth/auth-context', () => realAuthContextModule);
});

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { useMembers } = await import('../../../../core/admin/hooks/use-members');

type Result = ReturnType<typeof useMembers>;

function Harness({ onRender }: { onRender: (r: Result) => void }) {
    onRender(useMembers('org1'));
    return null;
}

test('useMembers pages through list-members until every member is loaded', async () => {
    const seen: { latest: Result | null } = { latest: null };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = window.document.createElement('div');
    const root = createRoot(container as unknown as Element);
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
