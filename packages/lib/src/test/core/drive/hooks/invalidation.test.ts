// A rename or a move refreshes what the item itself names: its own drive, its real parent folder and the
// breadcrumbs below it. The view it was started from plays no part, because a search result, a recent file or
// a row of another owner's drive sits in a view whose folder is not the item's parent.
import { beforeEach, expect, test } from 'bun:test';
import { driveKeys } from '../../../../core/drive/hooks/keys';
import type { DrivePath } from '../../../../types/drive';
import { DRIVE_MIME_DOC, DRIVE_MIME_FOLDER } from '../../../../types/drive';
import { renderHook } from '../../../render-hook';
import { hasKey, installTransferHarness, trackingClient } from '../../../transfer-harness';

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
};

// Runs one write on a client that already holds the breadcrumb of an open document below `projects`.
async function write(run: (writes: Writes) => Promise<unknown>) {
    const { act } = await import('react');
    const { useMovePaths, useRenamePath } = await import('../../../../core/drive/hooks/writes');
    const { queryClient, invalidated } = trackingClient();
    const below = driveKeys.breadcrumb(TEAM, MOUNT, 'doc-below');
    queryClient.setQueryData(below, []);
    const { latest, unmount } = await renderHook((): Writes => {
        const rename = useRenamePath();
        const move = useMovePaths();
        return {
            rename: (item, newName) => rename.mutateAsync({ path: item, newName }),
            move: (items, targetParentId) => move.mutateAsync({ paths: items, targetParentId }),
        };
    }, queryClient);
    await act(async () => {
        await run(latest);
    });
    await unmount();
    return { invalidated, breadcrumbBelowIsStale: queryClient.getQueryState(below)?.isInvalidated };
}

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
