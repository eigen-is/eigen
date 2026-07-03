import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { SSEventDrive } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { driveKeys } from './hooks/use-drive';
import { handleDriveSSEvent } from './sse-handlers';

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

const OWNER = 'owner-1';
const MOUNT = 'mount-1';
const PATH = 'path-1';
const PARENT = 'parent-1';

function driveEvent(type: SSEventDrive['type']): SSEventDrive {
    return {
        type,
        path: { ownerId: OWNER, mountId: MOUNT, id: PATH, parentId: PARENT, mimeType: 'image/png' },
    };
}

describe('handleDriveSSEvent — DRIVE_FILE_UPLOADED (overwrite)', () => {
    test("invalidates the uploaded file's own path detail, not just the parent folder", () => {
        const { queryClient, invalidated } = trackingClient();

        const handled = handleDriveSSEvent(driveEvent(SSEventType.DRIVE_FILE_UPLOADED), queryClient);

        expect(handled).toBe(true);
        // Parent folder listing (existing behaviour) still invalidated.
        expect(hasKey(invalidated, driveKeys.folder(OWNER, MOUNT, PARENT))).toBe(true);
        // The file's OWN detail must be invalidated so an overwrite refreshes the open detail/preview.
        expect(hasKey(invalidated, driveKeys.path(OWNER, MOUNT, PATH))).toBe(true);
    });

    test('a brand-new file create does not invalidate a phantom path detail', () => {
        const { queryClient, invalidated } = trackingClient();

        handleDriveSSEvent(driveEvent(SSEventType.DRIVE_FILE_CREATED), queryClient);

        expect(hasKey(invalidated, driveKeys.folder(OWNER, MOUNT, PARENT))).toBe(true);
        expect(hasKey(invalidated, driveKeys.path(OWNER, MOUNT, PATH))).toBe(false);
    });
});
