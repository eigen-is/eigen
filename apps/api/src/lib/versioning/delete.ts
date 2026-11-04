// Deletes a document's version history: its versions folder and that of each comment thread in its chat folder. Drive
// calls it for Delete history. Each folder goes under the path lock of the container it belongs to, the lock a
// snapshot of that container takes, so no version is written into a folder while it goes. A version's row in
// version_references goes with the version's row. A thread in the trash hangs elsewhere and keeps its versions.

import { DRIVE_TYPE_CHAT } from '@workspace/lib/types/drive';
import { CONTAINER_CHAT_FOLDER } from '../mount/container-dbs';
import type { Mount } from '../mount/mount';
import { isVersionsFolder, VERSIONS_FOLDER_NAME } from './versions-folder';

export async function deleteVersions(mount: Mount, containerId: string): Promise<void> {
    const chat = await mount.getChildByName(containerId, CONTAINER_CHAT_FOLDER);
    const threads = chat ? (await mount.listFolder(chat.id)).filter((child) => child.type === DRIVE_TYPE_CHAT) : [];
    for (const id of [containerId, ...threads.map((thread) => thread.id)]) {
        await mount.withPathLock(id, async () => {
            const versions = await mount.getChildByName(id, VERSIONS_FOLDER_NAME);
            if (versions && isVersionsFolder(versions)) await mount.deletePath(versions.id);
        });
    }
}
