// The names of the parts in an Eigen document's container folder that server code looks up by name: its own
// state in data.db, a collab document's comment index in comments.db, and the chat folder that holds its comment
// threads. Code that must tell a database from a user's own file asks isContainerDatabase, such as the drive's
// guard on user writes and the backup. A backup restore stages an archive while the API runs, so this file
// imports nothing that opens anything.

import type { DrivePathType } from '@workspace/lib/types/drive';
import { isDocumentType } from '@workspace/lib/types/drive';

export const CONTAINER_DATA_DB = 'data.db';
export const CONTAINER_COMMENTS_DB = 'comments.db';
// The folder of a document's comment threads, not the folder a user's own chats go in.
export const CONTAINER_CHAT_FOLDER = 'chat';

export function isContainerDatabase(name: string, parentType: DrivePathType): boolean {
    return (name === CONTAINER_DATA_DB || name === CONTAINER_COMMENTS_DB) && isDocumentType(parentType);
}
