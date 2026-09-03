import { DRIVE_TYPE_FOLDER, type DrivePath } from '@workspace/lib/types/drive';

// Snapshot history lives in <container>/versions/ — see STORAGE.md § File Versioning.
export const VERSIONS_FOLDER_NAME = 'versions';

export function isVersionsFolder(child: DrivePath): boolean {
    return child.type === DRIVE_TYPE_FOLDER && child.name === VERSIONS_FOLDER_NAME;
}
