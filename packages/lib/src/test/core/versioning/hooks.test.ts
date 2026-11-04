// Delete history refreshes the document's version list, so the menu shows what is left.
import { expect, test } from 'bun:test';
import { versionsKeys } from '../../../core/versioning/keys';
import { renderHook } from '../../render-hook';
import { hasKey, installTransferHarness, OWNER, toasts, trackingClient } from '../../transfer-harness';

installTransferHarness();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

test('Delete history sends the delete and refreshes the version list', async () => {
    const { act } = await import('react');
    const { useDeleteVersions } = await import('../../../core/versioning/hooks');
    const requests: string[] = [];
    g.fetch = async (url: string, init?: RequestInit) => {
        requests.push(`${init?.method} ${url}`);
        return Response.json({ success: true });
    };
    const { queryClient, invalidated } = trackingClient();
    const { latest, unmount } = await renderHook(() => useDeleteVersions(OWNER, 'm1', 'doc-1'), queryClient);

    await act(async () => {
        await latest.mutateAsync();
    });
    await unmount();

    expect(requests).toEqual([expect.stringMatching(/^DELETE .*\/drive\/a1b2c3d4\/m1\/file\/doc-1\/versions$/)]);
    expect(hasKey(invalidated, versionsKeys.container(OWNER, 'm1', 'doc-1'))).toBe(true);
    expect(toasts.at(-1)).toBe('success: Version history deleted');
});
