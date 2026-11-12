// The Trash lists what was deleted from every drive the viewer owns or co-owns: each of their own mounts and
// each mount of their teams. Its length is the sidebar's count. A drive whose trash fails to load is left out
// and named, and the others still list. A teammate's trash or restore refetches the team drive's list. Restore and Delete
// permanently go to the item's own drive, a selection refetches each drive's list once, and Empty trash empties the
// viewer's own mounts only.
import { beforeEach, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { DrivePath } from '../../../../types/drive';
import { teamOwnerId } from '../../../../types/owner';
import { SSEventType } from '../../../../types/sse';
import { renderHook } from '../../../render-hook';
import { installTransferHarness, OWNER, toasts } from '../../../transfer-harness';

installTransferHarness();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

const TEAM = teamOwnerId('design');

const trashed = (id: string, ownerId: string, mountId: string): DrivePath => ({
    id,
    name: `${id}.txt`,
    mountId,
    type: 'file',
    parentId: 'root',
    ownerId,
    mimeType: 'text/plain',
    size: 1,
    hash: null,
    thumbnail: null,
    acl: null,
    visibility: 'private',
    sharingRestricted: false,
    details: null,
    trashedAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
});

const OWN = trashed('own', OWNER, 'default');
const ARCHIVED = trashed('archived', OWNER, 'archive');
const TEAMS = trashed('teams', TEAM, 'shared');

// The server: the trash of each drive by its route, the routes that fail, and every request it got.
const server: { trash: Record<string, DrivePath[]>; failing: Set<string>; requests: string[] } = {
    trash: {},
    failing: new Set(),
    requests: [],
};

beforeEach(() => {
    toasts.length = 0;
    server.requests = [];
    server.failing = new Set();
    server.trash = {
        [`/drive/${OWNER}/default/trash`]: [OWN],
        [`/drive/${OWNER}/archive/trash`]: [ARCHIVED],
        [`/drive/${TEAM}/shared/trash`]: [TEAMS],
    };
    g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const route = new URL(input instanceof Request ? input.url : String(input)).pathname;
        const method = init?.method ?? 'GET';
        server.requests.push(`${method} ${route}`);
        if (server.failing.has(route)) return Response.json({ message: 'Storage is gone' }, { status: 500 });
        if (method !== 'GET') return Response.json({ success: true });
        if (route === `/drive/${OWNER}/mounts`) {
            return Response.json([
                { id: 'default', name: 'My Drive' },
                { id: 'archive', name: 'Archive' },
            ]);
        }
        if (route === `/home/${OWNER}/my-teams`) {
            return Response.json([{ id: 'design', name: 'Design', mounts: [{ id: 'shared', name: 'Design files' }] }]);
        }
        return Response.json(server.trash[route] ?? []);
    };
});

type Trash = ReturnType<typeof import('../../../../core/drive/hooks/trash').useTrash>;
type Writes = {
    restore: (items: readonly DrivePath[]) => Promise<unknown>;
    destroy: (items: readonly DrivePath[]) => Promise<unknown>;
    empty: () => Promise<unknown>;
};

// Mounts the Trash with its writes, as the page does, and waits for its lists.
async function openTrash(viewerId: string = OWNER) {
    const { act } = await import('react');
    const { useEmptyTrash, usePermanentlyDelete, useRestorePaths, useTrash } = await import(
        '../../../../core/drive/hooks/trash'
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const seen: { trash: Trash | null; writes: Writes | null } = { trash: null, writes: null };
    const flush = async () => {
        for (let i = 0; i < 10; i++) {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        }
    };
    const { unmount } = await renderHook(() => {
        seen.trash = useTrash(viewerId);
        const restore = useRestorePaths();
        const destroy = usePermanentlyDelete();
        const empty = useEmptyTrash(viewerId);
        seen.writes = { restore: restore.mutateAsync, destroy: destroy.mutateAsync, empty: () => empty.mutateAsync() };
    }, queryClient);
    await flush();
    if (!seen.trash || !seen.writes) throw new Error('the trash never rendered');
    const { writes } = seen;
    return {
        trash: (): Trash => {
            if (!seen.trash) throw new Error('the trash never rendered');
            return seen.trash;
        },
        write: (run: (writes: Writes) => Promise<unknown>) => act(async () => run(writes).catch(() => {})),
        queryClient,
        act,
        flush,
        unmount,
    };
}

const ids = (trash: Trash) => trash.items.map((item) => item.id).sort();

test('the trash lists every own mount and every team mount, and its length is the count', async () => {
    const { trash, unmount } = await openTrash();
    expect(ids(trash())).toEqual(['archived', 'own', 'teams']);
    expect(trash().items).toHaveLength(3);
    expect(trash().isLoading).toBe(false);
    expect(trash().error).toBeNull();
    expect(trash().failedDrives).toEqual([]);
    await unmount();
});

test('a drive whose trash fails to load is left out and named, and the others still list', async () => {
    server.failing.add(`/drive/${OWNER}/default/trash`);
    const { trash, unmount } = await openTrash();
    expect(ids(trash())).toEqual(['archived', 'teams']);
    expect(trash().error).toBeNull();
    expect(trash().failedDrives).toEqual(['My Drive']);
    await unmount();
});

test('a team drive whose trash fails to load is named by its mount, as the sidebar names it', async () => {
    server.failing.add(`/drive/${TEAM}/shared/trash`);
    const { trash, unmount } = await openTrash();
    expect(ids(trash())).toEqual(['archived', 'own']);
    expect(trash().failedDrives).toEqual(['Design files']);
    await unmount();
});

test('when the teams fail to load, the team drives are named as failed and the own drives still list', async () => {
    server.failing.add(`/home/${OWNER}/my-teams`);
    const { trash, unmount } = await openTrash();
    expect(ids(trash())).toEqual(['archived', 'own']);
    expect(trash().failedDrives).toEqual(['your team drives']);
    expect(trash().error).toBeNull();
    await unmount();
});

test('when the teams and every own drive fail to load, the trash is an error', async () => {
    server.failing.add(`/home/${OWNER}/my-teams`);
    server.failing.add(`/drive/${OWNER}/default/trash`);
    server.failing.add(`/drive/${OWNER}/archive/trash`);
    const { trash, unmount } = await openTrash();
    expect(trash().error).toBeInstanceOf(Error);
    await unmount();
});

test('a failed drive is no longer named once a refetch loads it', async () => {
    server.failing.add(`/drive/${TEAM}/shared/trash`);
    const { trash, queryClient, act, flush, unmount } = await openTrash();
    server.failing.clear();
    await act(() => queryClient.refetchQueries());
    await flush();
    expect(ids(trash())).toEqual(['archived', 'own', 'teams']);
    expect(trash().failedDrives).toEqual([]);
    await unmount();
});

test('a trash where every drive fails is an error', async () => {
    for (const route of Object.keys(server.trash)) server.failing.add(route);
    const { trash, unmount } = await openTrash();
    expect(trash().items).toEqual([]);
    expect(trash().error).toBeInstanceOf(Error);
    await unmount();
});

// Outside Drive the sidebar asks with no viewer, and then no drive's trash is read.
test('without a viewer no trash is fetched', async () => {
    const { trash, unmount } = await openTrash('');
    expect(trash().items).toEqual([]);
    expect(server.requests.filter((request) => request.endsWith('/trash'))).toEqual([]);
    await unmount();
});

test.each([SSEventType.DRIVE_PATH_TRASHED, SSEventType.DRIVE_PATH_RESTORED] as const)(
    'a teammate’s %s event refetches the team drive’s trash',
    async (type) => {
        const { handleDriveSSEvent } = await import('../../../../core/drive/sse-handlers');
        const { trash, queryClient, act, flush, unmount } = await openTrash();
        const later = trashed('later', TEAM, 'shared');
        server.trash[`/drive/${TEAM}/shared/trash`] = [TEAMS, later];
        handleDriveSSEvent(
            { type, path: { ownerId: TEAM, mountId: 'shared', id: 'later', parentId: 'root', mimeType: 'text/plain' } },
            queryClient,
            OWNER,
        );
        // The handler refreshes an owner's listings once, a moment after the burst of events.
        await act(() => Bun.sleep(300));
        await flush();
        expect(ids(trash())).toEqual(['archived', 'later', 'own', 'teams']);
        await unmount();
    },
);

test('Restore and Delete permanently go to the item’s own owner and mount', async () => {
    const { write, unmount } = await openTrash();
    server.requests = [];
    await write(({ restore }) => restore([TEAMS]));
    await write(({ destroy }) => destroy([TEAMS, ARCHIVED]));
    expect(server.requests.filter((request) => !request.startsWith('GET'))).toEqual([
        `POST /drive/${TEAM}/shared/trash/teams/restore`,
        `DELETE /drive/${TEAM}/shared/trash/teams`,
        `DELETE /drive/${OWNER}/archive/trash/archived`,
    ]);
    await unmount();
});

test('a restore or a permanent delete refetches the trash of the item’s drive', async () => {
    const { trash, write, flush, unmount } = await openTrash();
    server.trash[`/drive/${TEAM}/shared/trash`] = [];
    await write(({ restore }) => restore([TEAMS]));
    await flush();
    expect(ids(trash())).toEqual(['archived', 'own']);
    server.trash[`/drive/${OWNER}/archive/trash`] = [];
    await write(({ destroy }) => destroy([ARCHIVED]));
    await flush();
    expect(ids(trash())).toEqual(['own']);
    await unmount();
});

// Every invalidation of a list on screen starts its fetch, so 300 items of one drive sent 300 requests for its trash.
const ONE_DRIVE = ['a', 'b', 'c'].map((id) => trashed(id, OWNER, 'default'));
test.each([
    ['restore', ({ restore }: Writes) => restore(ONE_DRIVE)],
    ['permanent delete', ({ destroy }: Writes) => destroy(ONE_DRIVE)],
] as const)('a %s of several items of one drive refetches its trash once', async (_, run) => {
    const { write, flush, unmount } = await openTrash();
    server.requests = [];
    await write(run);
    await flush();
    expect(server.requests.filter((request) => request === `GET /drive/${OWNER}/default/trash`)).toHaveLength(1);
    await unmount();
});

test('restoring several items where one is refused says so in one message', async () => {
    const { write, unmount } = await openTrash();
    server.failing.add(`/drive/${OWNER}/default/trash/b/restore`);
    await write(({ restore }) => restore(ONE_DRIVE));
    expect(toasts).toEqual(['error: Failed to restore 1 of 3 items: Storage is gone (500)']);
    await unmount();
});

test('Empty trash empties every own mount and no team drive', async () => {
    const { trash, write, flush, unmount } = await openTrash();
    server.requests = [];
    server.trash[`/drive/${OWNER}/default/trash`] = [];
    server.trash[`/drive/${OWNER}/archive/trash`] = [];
    await write(({ empty }) => empty());
    await flush();
    expect(server.requests.filter((request) => request.startsWith('DELETE')).sort()).toEqual([
        `DELETE /drive/${OWNER}/archive/trash`,
        `DELETE /drive/${OWNER}/default/trash`,
    ]);
    expect(ids(trash())).toEqual(['teams']);
    await unmount();
});
