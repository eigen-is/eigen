// The drive read hooks, rendered against a stubbed transport. What this pins is the treaty choice:
// useVCardPreview reads a route that serves contact birthdays, and a Date here reaches
// ContactDetailCard's formatDateOnly, which splits a string.
import { afterAll, describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { installHappyDom } from '../../../happy-dom';

// react-dom needs a DOM to render the hooks into.
installHappyDom();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

// The real Eden client, so the reviver the hook reads through is the one under test.
const realFetch = g.fetch;
const payload = {
    cards: [
        {
            contact: {
                id: '',
                etag: '',
                firstName: 'Ada',
                lastName: 'Lovelace',
                email: ['ada@example.com'],
                phone: [],
                birthday: '1990-01-01',
            },
            categories: ['Work'],
        },
    ],
    dropped: 0,
    total: 1,
};
g.fetch = async () => Response.json(payload);

afterAll(() => {
    g.fetch = realFetch;
});

describe('useVCardPreview', () => {
    test('serves a card birthday as the date-only string it is, never a Date', async () => {
        const { act, createElement } = await import('react');
        const { createRoot } = await import('react-dom/client');
        const { QueryClientProvider } = await import('@tanstack/react-query');
        const { useVCardPreview } = await import('../../../../core/drive/hooks/reads');

        const seen: { latest: ReturnType<typeof useVCardPreview> | null } = { latest: null };
        function Harness() {
            seen.latest = useVCardPreview('owner-1', 'm1', 'p1', new Date(1), 1024);
            return null;
        }
        const container = document.createElement('div');
        const root = createRoot(container);
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        await act(async () => {
            root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, null)));
        });

        // The query resolves off a microtask and re-renders on a scheduled batch, so let it land.
        while (!seen.latest?.data) {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        }

        // The annotation is the type assertion: Eden carries the route's return type to the hook, so a
        // Date on the wire — or a payload that stopped being the preview's — fails `bun run typecheck`.
        const birthday: string | undefined = seen.latest?.data?.cards[0]?.contact.birthday;
        expect(birthday).toBe('1990-01-01');
        expect(birthday).not.toBeInstanceOf(Date);
        await act(() => root.unmount());
    });
});
