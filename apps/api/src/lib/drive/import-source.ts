// Reads the Drive file that an import-from-drive request names, for every route that imports one, such as
// a calendar, an address book, a mail message or a document. The source can live in any drive the user may
// read, another owner's included, and SharedDrive checks that access.

import { isContainerType } from '@workspace/lib/types/drive';
import type { DriveImportSource } from '@workspace/lib/types/drive-convert';
import { ApiError, payloadTooLarge } from '../core';
import { readStorageFile } from '../storage';
import type { User } from '../user';
import { getSharedDrive } from './get-drive';

// The recorded size of the source is only a claim, so the read itself carries the ceiling, and a source
// that grew since is cancelled instead of buffered.
export async function readImportSourceBytes(
    user: User,
    source: DriveImportSource,
    opts: { accepts: (mimeType: string, name: string) => boolean; rejection: string; maxBytes: number },
): Promise<Uint8Array> {
    const drive = await getSharedDrive(source.sourceOwnerId, user);
    const path = await drive.getPath(source.sourceMountId, source.sourcePathId);
    if (!path) throw new ApiError(404, 'Source file not found');
    if (isContainerType(path.type) || !opts.accepts(path.mimeType, path.name)) {
        throw new ApiError(400, opts.rejection);
    }
    if (path.size > opts.maxBytes) throw payloadTooLarge();

    return await drive.withHomeHeld(async () => {
        const file = await drive.downloadFile(source.sourceMountId, source.sourcePathId);
        if (!file) throw new ApiError(404, 'Source file not found');
        return new Uint8Array(await readStorageFile(file, { maxBytes: opts.maxBytes }));
    });
}
