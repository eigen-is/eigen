import type { DrivePath } from '../../../types/drive';

// Splits settled copy results into the successes and the failure count, and flags a total failure
// (something was requested and none of it copied). Pure so the media-folder copy semantics can be
// unit-tested without React; used only by useCopyToMediaFolder and its test — deliberately NOT in
// the hooks barrel (not a shared primitive).
export function partitionCopyResults(results: PromiseSettledResult<DrivePath>[]): {
    copied: DrivePath[];
    failedCount: number;
    totalFailure: boolean;
} {
    const copied = results
        .filter((r): r is PromiseFulfilledResult<DrivePath> => r.status === 'fulfilled')
        .map((r) => r.value);
    const failedCount = results.length - copied.length;
    return { copied, failedCount, totalFailure: failedCount > 0 && copied.length === 0 };
}
