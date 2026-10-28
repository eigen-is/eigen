import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { SSEventDrive } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { chatKeys } from '../../../core/chat/hooks/keys';
import { collabKeys } from '../../../core/collab/hooks/keys';
import { driveKeys } from '../../../core/drive/hooks/keys';
import { handleDriveSSEvent } from '../../../core/drive/sse-handlers';

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
});

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
        const { queryClient, invalidated } = trackingClient();

        handleDriveSSEvent(driveEvent(SSEventType.DRIVE_FILE_UPLOADED), queryClient, VIEWER);
        // Parent folder listing (existing behavior) still invalidated.
        expect(hasKey(invalidated, driveKeys.folder(OWNER, MOUNT, PARENT))).toBe(true);
        // The file's OWN detail must be invalidated so an overwrite refreshes the open detail/preview.
        expect(hasKey(invalidated, driveKeys.path(OWNER, MOUNT, PATH))).toBe(true);
    });

    test('a brand-new file create does not invalidate a phantom path detail', () => {
        const { queryClient, invalidated } = trackingClient();

        handleDriveSSEvent(driveEvent(SSEventType.DRIVE_FILE_CREATED), queryClient, VIEWER);

        expect(hasKey(invalidated, driveKeys.folder(OWNER, MOUNT, PARENT))).toBe(true);
        expect(hasKey(invalidated, driveKeys.path(OWNER, MOUNT, PATH))).toBe(false);
    });
});

describe('handleDriveSSEvent — DRIVE_FILE_HISTORY_UPDATED', () => {
    test('invalidates the owner-broad file-history queries so open Activity panels refresh live', () => {
        const { queryClient, invalidated } = trackingClient();

        handleDriveSSEvent(driveEvent(SSEventType.DRIVE_FILE_HISTORY_UPDATED), queryClient, VIEWER);
        expect(hasKey(invalidated, driveKeys.history(OWNER))).toBe(true);
    });
});

// A delete is always a delete from the trash, so a Trash view open in another tab must drop the row.
describe('handleDriveSSEvent — DRIVE_FILE_DELETED / DRIVE_FOLDER_DELETED', () => {
    test("refreshes the mount's trash list", () => {
        for (const type of [SSEventType.DRIVE_FILE_DELETED, SSEventType.DRIVE_FOLDER_DELETED] as const) {
            const { queryClient, invalidated } = trackingClient();
            handleDriveSSEvent(driveEvent(type), queryClient, VIEWER);
            expect(hasKey(invalidated, driveKeys.trashList(OWNER, MOUNT))).toBe(true);
        }
    });
});
