import type { SSEventDrive } from '@workspace/lib/types/sse';

export function buildDriveEvent(
    type: SSEventDrive['type'],
    path: SSEventDrive['path'],
    oldParentId?: string,
): SSEventDrive {
    return {
        type,
        path,
        ...(oldParentId && { oldParentId }),
    };
}
