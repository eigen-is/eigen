import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';

type DriveEventType = typeof SSEventType[keyof typeof SSEventType] & `drive:${string}`;

type PathData = { ownerId: string; mountId: string; id: string; parentId: string | null; mimeType: string | null };

export function buildDriveEvent(type: DriveEventType, path: PathData, oldParentId?: string): SSEvent {
    return {
        type,
        path,
        ...(oldParentId && {oldParentId}),
    } as SSEvent;
}
