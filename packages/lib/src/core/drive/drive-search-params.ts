// The ?pid=&uid=&mid= of a Drive listing's URL, such as a folder, Recent or a document app's index: the
// selected item whose detail opens beside the list, its owner and its mount. Every such route's
// validateSearch reads them here, since a URL can hold anything.

import type { DriveSearchParams } from '@workspace/lib/types/drive-view';

export function validateDriveSearch(search: Record<string, unknown>): DriveSearchParams {
    return {
        pid: typeof search.pid === 'string' ? search.pid : undefined,
        uid: typeof search.uid === 'string' ? search.uid : undefined,
        mid: typeof search.mid === 'string' ? search.mid : undefined,
    };
}
