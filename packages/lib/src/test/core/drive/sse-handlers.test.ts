import { afterAll, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { SSEventDrive } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { chatKeys } from '../../../core/chat/hooks/keys';
import { collabKeys } from '../../../core/collab/hooks/keys';
import { driveKeys } from '../../../core/drive/hooks/keys';
import { handleDriveSSEvent } from '../../../core/drive/sse-handlers';
import { notificationKeys } from '../../../core/notification/hooks/keys';
import { versionsKeys } from '../../../core/versioning/hooks/keys';
import { invalidatedBy } from '../../invalidation';

// A relayed drive event must never reach the user as a toast, so every toast is counted.
const toasts: string[] = [];
const realSonner = { ...(await import('sonner')) };
mock.module('sonner', () => ({
    ...realSonner,
    toast: Object.assign((message: string) => toasts.push(message), {
        success: (message: string) => toasts.push(message),
        error: (message: string) => toasts.push(message),
    }),
}));
afterAll(() => {
    mock.module('sonner', () => realSonner);
});
const { handleSSEvent } = await import('../../../core/sse/sse-handlers');

// Record every queryKey passed to invalidateQueries so we can assert which caches a handler touches.
function trackingClient(): { queryClient: QueryClient; invalidated: readonly unknown[][] } {
    const queryClient = new QueryClient();
    const invalidated: unknown[][] = [];
    const original = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = (filters?: { queryKey?: readonly unknown[] }) => {
        if (filters?.queryKey) invalidated.push([...filters.queryKey]);
        return original(filters as never);
    };
    return { queryClient, invalidated };
}

function hasKey(invalidated: readonly unknown[][], expected: readonly unknown[]): boolean {
    return invalidated.some((key) => JSON.stringify(key) === JSON.stringify(expected));
}

// The viewer is the signed-in user whose tab hears the event. The owner owns the path; they differ when a path is shared.
const OWNER = 'owner-1';
const VIEWER = 'viewer-1';
const MOUNT = 'mount-1';
const PATH = 'path-1';
const PARENT = 'parent-1';

function driveEvent(type: SSEventDrive['type']): SSEventDrive {
    return {
        type,
        path: { ownerId: OWNER, mountId: MOUNT, id: PATH, parentId: PARENT, mimeType: 'image/png' },
    };
}

describe('handleDriveSSEvent — DRIVE_ACL_UPDATED', () => {
    test('invalidates the mime-type listings so eigendoc app views (stickies/docs/…) refresh their rows', () => {
        const { queryClient, invalidated } = trackingClient();

        handleDriveSSEvent(driveEvent(SSEventType.DRIVE_ACL_UPDATED), queryClient, VIEWER);
        expect(hasKey(invalidated, driveKeys.path(OWNER, MOUNT, PATH))).toBe(true);
        // The share dialog in mime-filtered views reads its ACL from the listing row —
        // the mime prefix must be invalidated or the dialog reopens stale.
        expect(hasKey(invalidated, driveKeys.mimeTypes(OWNER))).toBe(true);
        // Assignment pickers read effective members — a new/removed collaborator must reach them now,
        // not after the 5-min staleTime. Owner-broad prefix (ancestor ACL affects descendants).
        expect(hasKey(invalidated, [...driveKeys.owner(OWNER), 'effective-members'])).toBe(true);
    });

    test("invalidates the viewer's chat lookups and shared-with-me list, which belong to the viewer, not the path's owner", () => {
        const { queryClient, invalidated } = trackingClient();

        handleDriveSSEvent(driveEvent(SSEventType.DRIVE_ACL_UPDATED), queryClient, VIEWER);
        expect(hasKey(invalidated, chatKeys.byMembersAll(VIEWER))).toBe(true);
        expect(hasKey(invalidated, driveKeys.shared(VIEWER, 'with-me'))).toBe(true);
        expect(hasKey(invalidated, chatKeys.byMembersAll(OWNER))).toBe(false);
    });
});

describe('handleDriveSSEvent — DRIVE_ACL_SHARED / DRIVE_ACL_UNSHARED', () => {
    test('invalidates the effective-members family so assignment pickers pick up the ACL change live', () => {
        for (const type of [SSEventType.DRIVE_ACL_SHARED, SSEventType.DRIVE_ACL_UNSHARED] as const) {
            const { queryClient, invalidated } = trackingClient();
            handleDriveSSEvent(driveEvent(type), queryClient, VIEWER);
            expect(hasKey(invalidated, [...driveKeys.owner(OWNER), 'effective-members'])).toBe(true);
        }
    });

    // The viewer's lists of one type span their teams and what others shared with them, so a share adds a row there.
    test("refreshes the viewer's lists of one type", () => {
        for (const type of [SSEventType.DRIVE_ACL_SHARED, SSEventType.DRIVE_ACL_UNSHARED] as const) {
            const { queryClient, invalidated } = trackingClient();
            handleDriveSSEvent(driveEvent(type), queryClient, VIEWER);
            expect(hasKey(invalidated, driveKeys.mimeAllTypes())).toBe(true);
        }
    });
});

// An unshare takes the path out of the sharee's reach, so their open Recent and Watched drop it now.
test.each([SSEventType.DRIVE_ACL_SHARED, SSEventType.DRIVE_ACL_UNSHARED, SSEventType.DRIVE_ACL_UPDATED] as const)(
    "%s refreshes the viewer's Recent and Watched",
    (type) => {
        const { queryClient, invalidated } = trackingClient();
        handleDriveSSEvent(driveEvent(type), queryClient, VIEWER);
        expect([driveKeys.recent(VIEWER), driveKeys.watchesAll()].map((key) => hasKey(invalidated, key))).toEqual([
            true,
            true,
        ]);
    },
);

// An open document reads its canRead/canWrite from its info query, so an owner who makes a writer a viewer, on the
// document or on a folder above it, reaches the open tab now. A role change on an existing share is DRIVE_ACL_UPDATED.
test('every ACL event refreshes the access of the open documents at and below the path', () => {
    for (const type of [
        SSEventType.DRIVE_ACL_UPDATED,
        SSEventType.DRIVE_ACL_SHARED,
        SSEventType.DRIVE_ACL_UNSHARED,
    ] as const) {
        const queryClient = new QueryClient();
        const own = collabKeys.document(OWNER, MOUNT, PATH);
        const below = collabKeys.document(OWNER, MOUNT, 'doc-below');
        const elsewhere = collabKeys.document(OWNER, 'mount-2', 'doc-elsewhere');
        for (const key of [own, below, elsewhere]) queryClient.setQueryData(key, { canWrite: true });
        handleDriveSSEvent(driveEvent(type), queryClient, VIEWER);
        const invalidated = (key: readonly unknown[]) => queryClient.getQueryState(key)?.isInvalidated;
        expect([invalidated(own), invalidated(below), invalidated(elsewhere)]).toEqual([true, true, false]);
    }
});

describe('handleDriveSSEvent — DRIVE_FILE_UPLOADED (overwrite)', () => {
    test("invalidates the uploaded file's own path detail, not just the parent folder", () => {
        const invalidated = invalidatedBy((queryClient) =>
            handleDriveSSEvent(driveEvent(SSEventType.DRIVE_FILE_UPLOADED), queryClient, VIEWER),
        );
        // The owner's folder listings, the parent's among them, still refetch.
        expect(hasKey(invalidated, driveKeys.folders(OWNER))).toBe(true);
        // The file's OWN detail must be invalidated so an overwrite refreshes the open detail/preview.
        expect(hasKey(invalidated, driveKeys.path(OWNER, MOUNT, PATH))).toBe(true);
    });

    test('a brand-new file create does not invalidate a phantom path detail', () => {
        const invalidated = invalidatedBy((queryClient) =>
            handleDriveSSEvent(driveEvent(SSEventType.DRIVE_FILE_CREATED), queryClient, VIEWER),
        );

        expect(hasKey(invalidated, driveKeys.folders(OWNER))).toBe(true);
        expect(hasKey(invalidated, driveKeys.path(OWNER, MOUNT, PATH))).toBe(false);
    });
});

// Every member of a team hears each file of a burst, such as 500 files dropped into a team folder. One fetch of
// the open folder per file would trip the server's per-IP rate limit, which an office's tabs share.
test('a burst of uploads refetches the open folder listing once', async () => {
    const queryClient = new QueryClient();
    let fetches = 0;
    const observer = new QueryObserver(queryClient, {
        queryKey: driveKeys.folder(OWNER, MOUNT, PARENT),
        queryFn: async () => {
            fetches++;
            return [];
        },
        staleTime: 60_000,
    });
    const unsubscribe = observer.subscribe(() => {});
    await Bun.sleep(10);
    fetches = 0;
    for (let i = 0; i < 50; i++) {
        const event = driveEvent(SSEventType.DRIVE_FILE_UPLOADED);
        handleDriveSSEvent({ ...event, path: { ...event.path, id: `file-${i}` } }, queryClient, VIEWER);
        await Bun.sleep(2);
    }
    await Bun.sleep(400);
    unsubscribe();
    expect(fetches).toBe(1);
});

// Emptying a trash of 500 items, or moving 500 files, sends one event per item too. The listings wait for the
// burst to end, but each path's own detail is dropped or marked stale as its event arrives.
describe.each([
    [SSEventType.DRIVE_PATH_TRASHED, 'gone'],
    [SSEventType.DRIVE_FILE_DELETED, 'gone'],
    [SSEventType.DRIVE_FOLDER_DELETED, 'gone'],
    [SSEventType.DRIVE_PATH_MOVED, 'stale'],
    [SSEventType.DRIVE_PATH_RENAMED, 'stale'],
] as const)('a burst of %s events', (type, detail) => {
    test('refetches an open folder listing once per owner, and each path detail at once', async () => {
        const queryClient = new QueryClient();
        const owners = [OWNER, 'owner-2'];
        const fetches: Record<string, number> = {};
        const unsubscribes = owners.map((ownerId) =>
            new QueryObserver(queryClient, {
                queryKey: driveKeys.folder(ownerId, MOUNT, PARENT),
                queryFn: async () => {
                    fetches[ownerId] = (fetches[ownerId] ?? 0) + 1;
                    return [];
                },
                staleTime: 60_000,
            }).subscribe(() => {}),
        );
        await Bun.sleep(10);
        for (const ownerId of owners) fetches[ownerId] = 0;

        const details: string[] = [];
        for (let i = 0; i < 20; i++) {
            const ownerId = owners[i % 2];
            const key = driveKeys.path(ownerId, MOUNT, `item-${i}`);
            queryClient.setQueryData(key, { id: `item-${i}` });
            handleDriveSSEvent(
                { type, path: { ...driveEvent(type).path, ownerId, id: `item-${i}` }, oldParentId: PARENT },
                queryClient,
                VIEWER,
            );
            const state = queryClient.getQueryState(key);
            details.push(state ? (state.isInvalidated ? 'stale' : 'fresh') : 'gone');
        }
        await Bun.sleep(400);
        for (const unsubscribe of unsubscribes) unsubscribe();

        expect(details).toEqual(Array(20).fill(detail));
        expect(fetches).toEqual({ [OWNER]: 1, 'owner-2': 1 });
    });
});

// The viewer's lists show another owner's item as it is now, and nothing else tells them that it changed.
test.each([
    SSEventType.DRIVE_PATH_TRASHED,
    SSEventType.DRIVE_PATH_RESTORED,
    SSEventType.DRIVE_PATH_MOVED,
    SSEventType.DRIVE_PATH_RENAMED,
    SSEventType.DRIVE_FILE_UPLOADED,
] as const)("%s on a shared path refreshes the viewer's Shared with me and type lists", async (type) => {
    const { queryClient, invalidated } = trackingClient();
    handleDriveSSEvent(driveEvent(type), queryClient, VIEWER);
    await Bun.sleep(400);
    expect(hasKey(invalidated, driveKeys.shared(VIEWER, 'with-me'))).toBe(true);
    expect(hasKey(invalidated, driveKeys.mimeAllTypes())).toBe(true);
});

// The trash list is a listing too: a Trash view open while another tab empties it refetches once.
test('a burst of deletes refetches the open trash list once', async () => {
    const queryClient = new QueryClient();
    let fetches = 0;
    const unsubscribe = new QueryObserver(queryClient, {
        queryKey: driveKeys.trashList(OWNER, MOUNT),
        queryFn: async () => {
            fetches++;
            return [];
        },
        staleTime: 60_000,
    }).subscribe(() => {});
    await Bun.sleep(10);
    fetches = 0;
    for (let i = 0; i < 20; i++) {
        const event = driveEvent(SSEventType.DRIVE_FILE_DELETED);
        handleDriveSSEvent({ ...event, path: { ...event.path, id: `item-${i}` } }, queryClient, VIEWER);
    }
    await Bun.sleep(400);
    unsubscribe();
    expect(fetches).toBe(1);
});

// A breadcrumb holds the names of the folders above its path, so a folder's rename or move reaches the open
// documents and folders below it.
test.each([SSEventType.DRIVE_PATH_RENAMED, SSEventType.DRIVE_PATH_MOVED] as const)(
    '%s refreshes the breadcrumb of an open item below the path',
    async (type) => {
        const queryClient = new QueryClient();
        const below = driveKeys.breadcrumb(OWNER, MOUNT, 'doc-below');
        const otherOwner = driveKeys.breadcrumb('owner-2', MOUNT, 'doc-elsewhere');
        for (const key of [below, otherOwner]) queryClient.setQueryData(key, []);
        handleDriveSSEvent(driveEvent(type), queryClient, VIEWER);
        await Bun.sleep(400);
        const invalidated = (key: readonly unknown[]) => queryClient.getQueryState(key)?.isInvalidated;
        expect([invalidated(below), invalidated(otherOwner)]).toEqual([true, false]);
    },
);

// A member's tab hears every change on a team drive and in the folders shared with them. It refetches, and that
// is all: no toast and no entry in the bell.
test('a drive event on a path someone else owns raises no toast and no notification', () => {
    const drive = Object.values(SSEventType).filter((type): type is SSEventDrive['type'] => type.startsWith('drive:'));
    toasts.length = 0;
    const invalidated = invalidatedBy((queryClient) => {
        for (const type of drive) handleSSEvent(driveEvent(type), queryClient, VIEWER);
    });
    expect(toasts).toEqual([]);
    expect(invalidated.filter((key) => key[0] === notificationKeys.all[0])).toEqual([]);
});

describe('handleDriveSSEvent — DRIVE_FILE_HISTORY_UPDATED', () => {
    test('invalidates the owner-broad file-history queries so open Activity panels refresh live', () => {
        const { queryClient, invalidated } = trackingClient();

        handleDriveSSEvent(driveEvent(SSEventType.DRIVE_FILE_HISTORY_UPDATED), queryClient, VIEWER);
        expect(hasKey(invalidated, driveKeys.history(OWNER))).toBe(true);
    });

    // A restore or Delete history in another tab records a file event, and the event names the document.
    test("refreshes the document's version list, so another tab's File menu lists what is left", () => {
        const { queryClient, invalidated } = trackingClient();

        handleDriveSSEvent(driveEvent(SSEventType.DRIVE_FILE_HISTORY_UPDATED), queryClient, VIEWER);
        expect(hasKey(invalidated, versionsKeys.container(OWNER, MOUNT, PATH))).toBe(true);
    });
});

// A delete is always a delete from the trash, so a Trash view open in another tab must drop the row. The sidebar
// keeps every drive's trash list open, so the events that cannot change a trash leave it alone.
test.each([
    [SSEventType.DRIVE_PATH_TRASHED, true],
    [SSEventType.DRIVE_PATH_RESTORED, true],
    [SSEventType.DRIVE_FILE_DELETED, true],
    [SSEventType.DRIVE_FOLDER_DELETED, true],
    [SSEventType.DRIVE_FILE_CREATED, false],
    [SSEventType.DRIVE_FILE_UPLOADED, false],
    [SSEventType.DRIVE_FOLDER_CREATED, false],
    [SSEventType.DRIVE_PATH_RENAMED, false],
    [SSEventType.DRIVE_PATH_MOVED, false],
] as const)("%s refreshes the owner's trash lists: %p", (type, refreshes) => {
    const invalidated = invalidatedBy((queryClient) => handleDriveSSEvent(driveEvent(type), queryClient, VIEWER));
    expect(hasKey(invalidated, driveKeys.trash(OWNER))).toBe(refreshes);
});

// Shared by me, Shared with me, Recent and Watched list items of several owners by name, and they are the viewer's.
test.each([
    SSEventType.DRIVE_PATH_RENAMED,
    SSEventType.DRIVE_PATH_MOVED,
    SSEventType.DRIVE_PATH_TRASHED,
    SSEventType.DRIVE_FILE_DELETED,
] as const)("%s refreshes the viewer's lists of other owners' items", (type) => {
    const invalidated = invalidatedBy((queryClient) => handleDriveSSEvent(driveEvent(type), queryClient, VIEWER));
    expect(
        [
            driveKeys.shared(VIEWER, 'by-me'),
            driveKeys.shared(VIEWER, 'with-me'),
            driveKeys.recent(VIEWER),
            driveKeys.watchesAll(),
        ].map((key) => hasKey(invalidated, key)),
    ).toEqual([true, true, true, true]);
});
