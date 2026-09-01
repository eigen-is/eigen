import type { DrivePath } from '../../../types/drive';

// Splits settled copy results into the successes and the failure count. Pure so the copy semantics can
// be unit-tested without React; used by the copy/duplicate/media-folder write hooks (writes.ts) and its
// test — deliberately NOT in the hooks barrel (not a shared primitive). A total failure (something was
// requested and none of it copied) is `failedCount > 0 && copied.length === 0`, derived by the one
// hook that cares (useCopyToMediaFolder).
export function partitionCopyResults(results: PromiseSettledResult<DrivePath>[]): {
    copied: DrivePath[];
    failedCount: number;
} {
    const copied = results
        .filter((r): r is PromiseFulfilledResult<DrivePath> => r.status === 'fulfilled')
        .map((r) => r.value);
    const failedCount = results.length - copied.length;
    return { copied, failedCount };
}
