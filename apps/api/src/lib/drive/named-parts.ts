// What a stored state of a collab document names among its own parts: the files in its media folder, with the
// siblings an SVG among them draws, its comment threads, and the files each thread's messages name. The sweep keeps
// what any kept state names, and a copy takes only what the current state names. Every stored database is read from a
// temp copy of its own, so a read opens nothing through the mount and stamps no row.

import { Database as BunDatabase } from 'bun:sqlite';
import type { DriveCollabType, DrivePath } from '@workspace/lib/types/drive';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as chatSchema from '../chat/schema';
import { readYjsStatePayloadFromFile } from '../collab/yjs-loader';
import { runDocumentReferences } from '../document/transform/run-transform';
import type { TransformPriority } from '../document/transform/runner';
import { documentTransformRunner } from '../document/transform/runner';
import type { Mount } from '../mount';
import { RowMemo } from '../mount/helpers';
import { foldName } from '../mount/names';
import type { DocumentReferences } from '../mount/schema';
import { withSvgSiblings } from '../preview/svg-media-inline';

// The files each kept thread's messages name, by its data.db. A thread that names an old file would otherwise be read
// at every sweep, and on a bucket that read is a whole download. So it is read again only once a sync changed its row.
const attachmentNames = new RowMemo<ReadonlySet<string>>();

// The parts one stored state names, such as a document's data.db or one of its versions. Each read is a job of its
// own, so memory and the transform process's time stay bounded to one state. A read of the current state is given the
// cards the saved versions have in use.
export async function storedReferences(
    mount: Mount,
    documentType: DriveCollabType,
    pathId: string,
    priority: TransformPriority,
    versionCards?: readonly string[],
): Promise<DocumentReferences> {
    // A job the transform process would refuse is refused before the download, so it costs nothing.
    documentTransformRunner.assertAdmissible(priority);
    const source = await readStoredCopy(mount, pathId, readYjsStatePayloadFromFile);
    return runDocumentReferences({ documentType, source, versionCards }, { priority });
}

// The files in a media folder that the names keep, folded the way getChildByName finds a file, whatever its case or
// Unicode form. A file an SVG among them draws is kept too, but the SVGs are read only when one of the files that
// could go is not among the names.
export async function mediaKeptBy(
    mount: Mount,
    mediaId: string,
    names: readonly string[],
    couldGo: readonly DrivePath[],
): Promise<ReadonlySet<string>> {
    const kept = new Set(names.map(foldName));
    if (couldGo.every((file) => kept.has(foldName(file.name)))) return kept;
    return new Set([...(await withSvgSiblings(mount, mediaId, names))].map(foldName));
}

// The files a thread's messages name, a deleted message included, folded the same way.
export function threadAttachmentNames(mount: Mount, dataDb: DrivePath): Promise<ReadonlySet<string>> {
    return attachmentNames.get(dataDb, () => readStoredCopy(mount, dataDb.id, readAttachmentNames));
}

// A database nobody serves, such as a closed document's data.db, a version or a thread's data.db, is read from a temp
// copy. On a bucket the copy is the staged one while its upload is pending, so it is the newest.
async function readStoredCopy<T>(mount: Mount, pathId: string, read: (localPath: string) => T): Promise<T> {
    const tempId = crypto.randomUUID();
    try {
        return read(await mount.downloadToTemp(pathId, tempId));
    } finally {
        await mount.cleanupTemp(tempId);
    }
}

// A message's attachment is a file in the thread's media folder when it is a string, and a Drive reference otherwise.
function readAttachmentNames(localPath: string): Set<string> {
    const rawDb = new BunDatabase(localPath);
    try {
        const rows = drizzle(rawDb, { schema: chatSchema })
            .select({ attachments: chatSchema.messages.attachments })
            .from(chatSchema.messages)
            .all();
        const names = rows
            .flatMap((row) => row.attachments ?? [])
            .filter((attachment) => typeof attachment === 'string');
        return new Set(names.map(foldName));
    } finally {
        rawDb.close();
    }
}
