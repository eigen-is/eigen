import { describe, expect, test } from 'bun:test';
import { subjectFromPath } from '@workspace/lib/file-subject';
import { browseCapabilities, DRIVE_CAPABILITIES } from '../../../components/drive/drive-capabilities';
import { drivePath } from '../../drive-path';

const path = drivePath({ name: 'Report.pdf', mimeType: 'application/pdf', ownerId: 'someone-else' });
const byName = () => true;

describe('browseCapabilities', () => {
    test('a viewer who writes gets the full browser, which asks per item who moves and shares', () => {
        expect(browseCapabilities(true, byName)).toEqual({ ...DRIVE_CAPABILITIES.browse, writesByName: byName });
    });

    test('a viewer who cannot write is offered nothing that writes', () => {
        const caps = browseCapabilities(false, byName);
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
        expect(browseCapabilities(false, byName).showBreadcrumb).toBe(true);
    });

    test('capabilities.canWrite is what marks the row subjects read-only', () => {
        expect(subjectFromPath(path, browseCapabilities(true, byName).canWrite).readOnly).toBeUndefined();
        expect(subjectFromPath(path, browseCapabilities(false, byName).canWrite).readOnly).toBe(true);
    });
});
