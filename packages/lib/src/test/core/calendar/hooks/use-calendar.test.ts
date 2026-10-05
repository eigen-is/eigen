// Both calendar dialogs lock an invitation's details through useIsInvitationFromOthers, so what it answers
// while the owner's address is still on its way is pinned here.
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { EventData } from '@workspace/lib/types/calendar';
import { publicUserKeys } from '../../../../core/public/hooks/keys';
import { installHappyDom } from '../../../happy-dom';

// react-dom needs a DOM to render the hook into.
installHappyDom();

const VIEWER = 'v1ewer0000000000000000000000000a';
const OWNER = '0wner00000000000000000000000000b';

// No provider here: the viewer comes from a stub, and an owner's address never arrives unless a test seeds it.
const realAuthContextModule = await import('../../../../core/auth/auth-context');
const realUserBatcherModule = await import('../../../../core/public/user-batcher');
mock.module('../../../../core/auth/auth-context', () => ({
    useAuth: () => ({ user: { id: VIEWER, email: 'viewer@eigen.test' } }),
}));
mock.module('../../../../core/public/user-batcher', () => ({ fetchPublicUser: () => new Promise(() => {}) }));

afterAll(() => {
    mock.module('../../../../core/auth/auth-context', () => realAuthContextModule);
    mock.module('../../../../core/public/user-batcher', () => realUserBatcherModule);
});

const { useIsInvitationFromOthers } = await import('../../../../core/calendar/hooks/use-calendar');

const organizedBy = (email: string): { data: EventData } => ({ data: { organizer: { userId: '', email } } });

describe('useIsInvitationFromOthers', () => {
    test("a shared calendar's event counts as an invitation until its owner's address arrives", async () => {
        const { latest, unmount } = await renderHook(() => useIsInvitationFromOthers(OWNER), new QueryClient());
        expect(latest?.(organizedBy('owner@eigen.test'))).toBe(true);
        await unmount();
    });

    test("the owner's address tells their own event from an invitation", async () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(publicUserKeys.detail(OWNER), { email: 'owner@eigen.test' });
        const { latest, unmount } = await renderHook(() => useIsInvitationFromOthers(OWNER), queryClient);
        expect(latest?.(organizedBy('Owner@eigen.test'))).toBe(false);
        expect(latest?.(organizedBy('someone@else.test'))).toBe(true);
        await unmount();
    });

    test("the viewer's own calendar compares with the viewer's address", async () => {
        const { latest, unmount } = await renderHook(() => useIsInvitationFromOthers(VIEWER), new QueryClient());
        expect(latest?.(organizedBy('viewer@eigen.test'))).toBe(false);
        expect(latest?.(organizedBy('someone@else.test'))).toBe(true);
        await unmount();
    });
});

// One React root for every hook that has to be rendered to be observed.
async function renderHook<T>(
    use: () => T,
    queryClient: QueryClient,
): Promise<{ latest: T | null; unmount: () => Promise<void> }> {
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { QueryClientProvider } = await import('@tanstack/react-query');

    const seen: { latest: T | null } = { latest: null };
    function Harness() {
        seen.latest = use();
        return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => {
        root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, null)));
    });
    // Unmount inside act too: React's scheduler would otherwise run the teardown after the test,
    // when the DOM globals are already gone.
    const unmount = async () => {
        await act(async () => {
            root.unmount();
        });
    };
    return { latest: seen.latest, unmount };
}
