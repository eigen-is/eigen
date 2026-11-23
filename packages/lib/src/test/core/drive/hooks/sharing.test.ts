// The sharing hooks against a recorded fetch. useUpdateACL writes to the owner and mount the path names, not
// the view's, and refreshes the sharer's own lists when the sharer is not the owner. The permission and member
// reads ask nothing while there is no path, and cache under the keys the invalidators clear.
import { beforeEach, describe, expect, test } from 'bun:test';
import { driveKeys } from '../../../../core/drive/hooks/keys';
import type { DrivePath } from '../../../../types/drive';
import { renderHook } from '../../../render-hook';
import { hasKey, installTransferHarness, OWNER, trackingClient } from '../../../transfer-harness';

installTransferHarness();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

const TEAM = 'e5f6a7b8';

const path = (ownerId: string): DrivePath => ({
    id: 'doc',
    name: 'doc.txt',
    mountId: 'm2',
    type: 'file',
    parentId: 'folder',
    ownerId,
    mimeType: 'text/plain',
    size: 1,
    hash: null,
    thumbnail: null,
    acl: null,
    visibility: 'private',
    sharingRestricted: false,
    details: null,
    trashedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
});

// The route each request reached; the origin is whatever page the DOM of the moment is on.
const requests: { method: string; url: string; body: unknown }[] = [];

beforeEach(() => {
    requests.length = 0;
    g.fetch = async (url: string, init?: RequestInit) => {
        requests.push({
            method: init?.method ?? 'GET',
            url: new URL(url).pathname,
            body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        if (url.endsWith('/permissions')) return Response.json({ canRead: true, canWrite: false });
        if (url.endsWith('/effective-members')) return Response.json([]);
        return Response.json({ ok: true });
    };
});

async function updateACL(target: DrivePath): Promise<readonly unknown[][]> {
    const { act } = await import('react');
    const { useUpdateACL } = await import('../../../../core/drive/hooks/sharing');
    const { queryClient, invalidated } = trackingClient();
    const { latest, unmount } = await renderHook(() => useUpdateACL(), queryClient);
    await act(async () => {
        await latest.mutateAsync({
            path: target,
            add: [{ id: 'ada@example.com', read: true, write: false }],
            visibility: 'public-read',
        });
    });
    await unmount();
    return invalidated;
}

describe('useUpdateACL', () => {
    test("puts the change to the path's own owner and mount", async () => {
        await updateACL(path(TEAM));
        expect(requests).toEqual([
            {
                method: 'PUT',
                url: `/drive/${TEAM}/m2/path/doc/acl`,
                body: { add: [{ id: 'ada@example.com', read: true, write: false }], visibility: 'public-read' },
            },
        ]);
    });

    test("refreshes the path's permissions, and the sharer's own lists when the path is someone else's", async () => {
        const invalidated = await updateACL(path(TEAM));
        expect(hasKey(invalidated, driveKeys.permissions(TEAM, 'm2', 'doc'))).toBe(true);
        expect(hasKey(invalidated, driveKeys.recent(OWNER))).toBe(true);
    });

    test("the owner's own share leaves the viewer lists alone", async () => {
        const invalidated = await updateACL(path(OWNER));
        expect(hasKey(invalidated, driveKeys.recent(OWNER))).toBe(false);
    });
});

describe('the sharing reads', () => {
    async function read(pathId: string | undefined) {
        const { act } = await import('react');
        const { useCheckPermissions, useEffectiveMembers } = await import('../../../../core/drive/hooks/sharing');
        const { queryClient } = trackingClient();
        const { unmount } = await renderHook(() => {
            useCheckPermissions(TEAM, 'm2', pathId);
            useEffectiveMembers(TEAM, 'm2', pathId);
        }, queryClient);
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
        await unmount();
        return queryClient;
    }

    test('a missing path asks the server nothing', async () => {
        await read(undefined);
        expect(requests).toEqual([]);
    });

    test('a present path caches under the keys the invalidators clear', async () => {
        const queryClient = await read('doc');
        expect(requests.map((request) => request.url).sort()).toEqual([
            `/drive/${TEAM}/m2/path/doc/effective-members`,
            `/drive/${TEAM}/m2/path/doc/permissions`,
        ]);
        expect(queryClient.getQueryData(driveKeys.permissions(TEAM, 'm2', 'doc'))).toEqual({
            canRead: true,
            canWrite: false,
        });
        expect(queryClient.getQueryData(driveKeys.effectiveMembers(TEAM, 'm2', 'doc'))).toEqual([]);
    });
});
