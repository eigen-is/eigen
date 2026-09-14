import { describe, expect, test } from 'bun:test';
import { subjectFromPath } from '@workspace/lib/file-subject';
import type { DrivePath } from '@workspace/lib/types/drive';
import { browseCapabilities, DRIVE_CAPABILITIES } from '../../../components/drive/drive-capabilities';

const path = {
    id: 'p1',
    mountId: 'm1',
    name: 'Report.pdf',
    type: 'file',
    parentId: 'root',
    ownerId: 'someone-else',
    mimeType: 'application/pdf',
    size: 10,
    hash: null,
    thumbnail: null,
    acl: null,
    visibility: 'private',
    sharingRestricted: false,
    details: null,
    trashedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
} satisfies DrivePath;

describe('browseCapabilities', () => {
    test('a viewer who can write gets the full browser', () => {
        expect(browseCapabilities(true)).toBe(DRIVE_CAPABILITIES.browse);
    });

    test('a viewer who cannot write is offered nothing that writes', () => {
        const caps = browseCapabilities(false);
        expect(caps.canWrite).toBe(false);
        expect(caps.canDelete).toBe(false);
        expect(caps.canRename).toBe(false);
        expect(caps.canMove).toBe(false);
        expect(caps.canCreateFolder).toBe(false);
        expect(caps.canUpload).toBe(false);
        expect(caps.canShare).toBe(false);
        expect(caps.createTypes?.size).toBe(0);
    });

    test('a read-only folder still browses — the fs view keeps its breadcrumb', () => {
        expect(browseCapabilities(false).showBreadcrumb).toBe(true);
    });

    test('capabilities.canWrite is what marks the row subjects read-only', () => {
        expect(subjectFromPath(path, browseCapabilities(true).canWrite).readOnly).toBeUndefined();
        expect(subjectFromPath(path, browseCapabilities(false).canWrite).readOnly).toBe(true);
    });
});
