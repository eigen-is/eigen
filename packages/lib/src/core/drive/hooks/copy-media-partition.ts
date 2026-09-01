import type { DrivePath } from '../../../types/drive';

// Splits settled copy results into the successes and the failure count, and flags a total failure
// (something was requested and none of it copied). Pure so the copy semantics can be unit-tested
// without React; used by the copy/duplicate/media-folder write hooks (writes.ts) and its test —
// deliberately NOT in the hooks barrel (not a shared primitive). `totalFailure` is read only by
// useCopyToMediaFolder; the other hooks use `copied` + `failedCount`.
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
