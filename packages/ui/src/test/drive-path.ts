import type { DrivePath } from '@workspace/lib/types/drive';

export function drivePath(p: Partial<DrivePath> & { name: string; mimeType: string }): DrivePath {
    return {
        id: 'path-1',
        mountId: 'default',
        type: 'file',
        parentId: null,
        ownerId: 'owner-1',
        size: 0,
        hash: null,
        thumbnail: null,
        acl: null,
        visibility: 'private',
        sharingRestricted: false,
        details: null,
        trashedAt: null,
        createdAt: new Date('2026-09-20T09:00:00Z'),
        updatedAt: new Date('2026-09-20T09:00:00Z'),
        ...p,
    };
}
