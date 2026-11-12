// A rename or a move refreshes what the item itself names: its own drive, its real parent folder and the
// breadcrumbs below it. The view it was started from plays no part, because a search result, a recent file or
// a row of another owner's drive sits in a view whose folder is not the item's parent. The viewer's lists that
// gather items of several owners, such as Shared with me and Recent, refresh too. A batch refetches an open
// listing once, however many of its items changed.
import { beforeEach, expect, test } from 'bun:test';
import { QueryObserver } from '@tanstack/react-query';
import { driveKeys } from '../../../../core/drive/hooks/keys';
import type { DrivePath } from '../../../../types/drive';
import { DRIVE_MIME_DOC, DRIVE_MIME_FOLDER } from '../../../../types/drive';
import { renderHook } from '../../../render-hook';
import { hasKey, installTransferHarness, OWNER, trackingClient } from '../../../transfer-harness';

installTransferHarness();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

const TEAM = 'team-1';
const MOUNT = 'team-mount';

const path = (overrides: Partial<DrivePath>): DrivePath => ({
    id: 'report',
    name: 'Report.eigendoc',
    mountId: MOUNT,
    type: 'doc',
    parentId: 'real-parent',
    ownerId: TEAM,
    mimeType: DRIVE_MIME_DOC,
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
    ...overrides,
});

const report = path({});
const projects = path({ id: 'projects', name: 'Projects', type: 'folder', mimeType: DRIVE_MIME_FOLDER });

const requests: string[] = [];
beforeEach(() => {
    requests.length = 0;
    g.fetch = async (url: string) => {
        requests.push(new URL(url).pathname);
        return Response.json(report);
    };
});

type Writes = {
    rename: (item: DrivePath, newName: string) => Promise<unknown>;
    move: (items: readonly DrivePath[], targetParentId: string) => Promise<unknown>;
    remove: (items: readonly DrivePath[]) => Promise<unknown>;
};

// Runs one write on a client that already holds the breadcrumb of an open document below `projects`, with the
// item's folder open on screen, whose fetches it counts.
async function write(run: (writes: Writes) => Promise<unknown>) {
    const { act } = await import('react');
    const { useDeletePaths, useMovePaths, useRenamePath } = await import('../../../../core/drive/hooks/writes');
    const { queryClient, invalidated } = trackingClient();
    const below = driveKeys.breadcrumb(TEAM, MOUNT, 'doc-below');
    queryClient.setQueryData(below, []);
    let folderFetches = 0;
    const unsubscribe = new QueryObserver(queryClient, {
        queryKey: driveKeys.folder(TEAM, MOUNT, 'real-parent'),
        queryFn: async () => {
            folderFetches++;
            return [];
        },
        staleTime: 60_000,
    }).subscribe(() => {});
    await act(() => Bun.sleep(10));
    folderFetches = 0;
    const { latest, unmount } = await renderHook((): Writes => {
        const rename = useRenamePath();
        const move = useMovePaths();
        const remove = useDeletePaths();
        return {
            rename: (item, newName) => rename.mutateAsync({ path: item, newName }),
            move: (items, targetParentId) => move.mutateAsync({ paths: items, targetParentId }),
            remove: (items) => remove.mutateAsync(items),
        };
    }, queryClient);
    await act(async () => {
        await run(latest);
        await Bun.sleep(10);
    });
    unsubscribe();
    await unmount();
    return { invalidated, folderFetches, breadcrumbBelowIsStale: queryClient.getQueryState(below)?.isInvalidated };
}

const three = ['one', 'two', 'three'].map((id) => path({ id }));

test('a rename goes to the item’s own drive and refreshes its real parent folder', async () => {
    const { invalidated } = await write(({ rename }) => rename(report, 'Minutes.eigendoc'));
    expect(requests).toEqual([`/drive/${TEAM}/${MOUNT}/path/report/rename`]);
    expect(hasKey(invalidated, driveKeys.folder(TEAM, MOUNT, 'real-parent'))).toBe(true);
    expect(hasKey(invalidated, driveKeys.path(TEAM, MOUNT, 'report'))).toBe(true);
    expect(hasKey(invalidated, driveKeys.mimeTypes(TEAM))).toBe(true);
});

test('a move goes to each item’s own drive and refreshes the folder it left and the one it entered', async () => {
    const { invalidated } = await write(({ move }) => move([report], 'archive'));
    expect(requests).toEqual([`/drive/${TEAM}/${MOUNT}/path/report/move`]);
    expect(hasKey(invalidated, driveKeys.folder(TEAM, MOUNT, 'real-parent'))).toBe(true);
    expect(hasKey(invalidated, driveKeys.folder(TEAM, MOUNT, 'archive'))).toBe(true);
});

test('renaming a folder refreshes the breadcrumb of an open item below it', async () => {
    const { breadcrumbBelowIsStale } = await write(({ rename }) => rename(projects, 'Archive'));
    expect(breadcrumbBelowIsStale).toBe(true);
});

test('moving a folder refreshes the breadcrumb of an open item below it', async () => {
    const { breadcrumbBelowIsStale } = await write(({ move }) => move([projects], 'archive'));
    expect(breadcrumbBelowIsStale).toBe(true);
});

// Every invalidation of a listing on screen starts its fetch, so 300 deleted items sent 300 requests for one folder.
test.each([
    ['delete', ({ remove }: Writes) => remove(three)],
    ['move', ({ move }: Writes) => move(three, 'archive')],
] as const)('a %s of several items of one folder refetches its open listing once', async (_, run) => {
    const { folderFetches } = await write(run);
    expect(folderFetches).toBe(1);
});

// Shared by me, Shared with me, Recent and Watched list items of several owners by name.
test.each([
    ['rename', ({ rename }: Writes) => rename(report, 'Minutes.eigendoc')],
    ['move', ({ move }: Writes) => move([report], 'archive')],
    ['delete', ({ remove }: Writes) => remove([report])],
] as const)('a %s refreshes the viewer’s lists of other owners’ items', async (_, run) => {
    const { invalidated } = await write(run);
    expect(
        [
            driveKeys.shared(OWNER, 'by-me'),
            driveKeys.shared(OWNER, 'with-me'),
            driveKeys.recent(OWNER),
            driveKeys.watchesAll(),
        ].map((key) => hasKey(invalidated, key)),
    ).toEqual([true, true, true, true]);
});
