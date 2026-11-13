// The names of the parts in an Eigen document's container folder that server code looks up by name, such as its
// state in data.db, a collab document's comment index in comments.db and the folders of its threads and its files,
// which the client finds by name too.
// Code that must tell a database from a user's own file asks isContainerDatabase, such as the backup. A backup restore
// stages an archive while the API runs, so this file opens nothing.

import type { DrivePathType } from '@workspace/lib/types/drive';
import { isCollabType, isDocumentType } from '@workspace/lib/types/drive';

export { CONTAINER_CHAT_FOLDER, CONTAINER_MEDIA_FOLDER } from '@workspace/lib/constants/container';

export const CONTAINER_DATA_DB = 'data.db';
export const CONTAINER_COMMENTS_DB = 'comments.db';

// Every Eigen document has its data.db, and only a collab document a comments.db, so a file of that name in a chat
// is a user's own.
export function isContainerDatabase(name: string, parentType: DrivePathType): boolean {
    if (name === CONTAINER_DATA_DB) return isDocumentType(parentType);
    return name === CONTAINER_COMMENTS_DB && isCollabType(parentType);
}
