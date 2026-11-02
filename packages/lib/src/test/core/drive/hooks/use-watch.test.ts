// A watch toggle refreshes the watch state of the item it ran on. The command palette hands the hook no
// item once it closes, which it does as soon as a row runs, so the answer arrives after the host moved on.
import { expect, test } from 'bun:test';
import { driveKeys } from '../../../../core/drive/hooks/keys';
import { renderHook } from '../../../render-hook';
import { hasKey, installTransferHarness, OWNER, trackingClient } from '../../../transfer-harness';

installTransferHarness();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

const ITEM = { ownerId: OWNER, mountId: 'm1', pathId: 'item-1' };
const NOTHING = { ownerId: '', mountId: '', pathId: '' };

test('Watch refreshes the item it ran on after the host hands the hook no item', async () => {
    const { act, useState } = await import('react');
    const { useWatchToggle } = await import('../../../../core/drive/hooks/use-watch');
    let answer = () => {};
    g.fetch = async (_url: string, init?: RequestInit) => {
        if (init?.method !== 'POST') return Response.json({ direct: false, viaAncestor: null });
        await new Promise<void>((resolve) => {
            answer = resolve;
        });
        return Response.json({ ok: true });
    };
    const { queryClient, invalidated } = trackingClient();
    const { latest, unmount } = await renderHook(() => {
        const [target, setTarget] = useState(ITEM);
        return { watch: useWatchToggle(target.ownerId, target.mountId, target.pathId), setTarget };
    }, queryClient);

    await act(async () => latest.watch.toggle());
    await act(async () => latest.setTarget(NOTHING));
    await act(async () => {
        answer();
        await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await unmount();

    expect(hasKey(invalidated, driveKeys.pathWatched(ITEM.ownerId, ITEM.mountId, ITEM.pathId))).toBe(true);
    expect(hasKey(invalidated, driveKeys.watches(ITEM.ownerId))).toBe(true);
    expect(hasKey(invalidated, driveKeys.watches(''))).toBe(false);
});
