// The Recent list is cached under the signed-in user's own key, so a personal and a team context never serve
// each other's list, and it reads the user's own recent route.
import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { renderHook } from '../../../render-hook';
import { installTransferHarness, OWNER } from '../../../transfer-harness';

installTransferHarness();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

test('the Recent list is cached under a key that names its owner', async () => {
    const { act } = await import('react');
    const { useRecentPaths } = await import('../../../../core/drive/hooks/use-recent-paths');
    const urls: string[] = [];
    g.fetch = async (url: string) => {
        urls.push(String(url));
        return Response.json([]);
    };
    const queryClient = new QueryClient();
    const { unmount } = await renderHook(() => useRecentPaths(), queryClient);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await unmount();

    expect(
        queryClient
            .getQueryCache()
            .getAll()
            .map((query) => query.queryKey),
    ).toEqual([['drive', OWNER, 'recent']]);
    expect(urls.some((url) => url.endsWith(`/drive/${OWNER}/recent`))).toBe(true);
});
