import { type DriveImportSource, isContainerType } from '@workspace/lib/types/drive';
import { ApiError } from '../core';
import { readStorageFile } from '../storage';
import type { User } from '../user';
import { getSharedDrive } from './get-drive';

// The bytes of the Drive file an import-from-drive body names, for every route that ingests one: the
// source can live in any drive the user may read (SharedDrive checks that), and its recorded size is only
// a claim, so the read itself carries the ceiling and a source that grew since is cancelled, not buffered.
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
    if (path.size > opts.maxBytes) throw new ApiError(413, 'Upload too large');

    const file = await drive.downloadFile(source.sourceMountId, source.sourcePathId);
    if (!file) throw new ApiError(404, 'Source file not found');
    return new Uint8Array(await readStorageFile(file, { maxBytes: opts.maxBytes }));
}
