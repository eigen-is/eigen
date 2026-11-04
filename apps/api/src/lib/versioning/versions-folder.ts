// The name of the folder inside a document's container that holds its saved versions, one database file each. A
// save makes the folder on first use, and other code finds it by this name, such as a restore or Delete history.
// Every lookup ignores case the way getChildByName does, so a check of the name folds it the same way.

import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_FOLDER } from '@workspace/lib/types/drive';
import { foldName } from '../mount/names';

export const VERSIONS_FOLDER_NAME = 'versions';

export function isVersionsName(name: string): boolean {
    return foldName(name) === VERSIONS_FOLDER_NAME;
}

export function isVersionsFolder(child: DrivePath): boolean {
    return child.type === DRIVE_TYPE_FOLDER && isVersionsName(child.name);
}
