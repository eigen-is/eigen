import { toast } from 'sonner';
import type { ImportCountsResult } from '../types/transfer';

// What a file's unreadable members are called, spelled once for the import toast and for the counted
// line a quick look of the same file ends on.
export function unreadableLine(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'} could not be read`;
}

// One phrasing for every counted import: a file from the disk and a file from Drive report the same three
// counts. Nothing imported and nothing skipped means the file held nothing this book or calendar could
// take — unreadable members say so, because the file did hold members and none of them landed.
export function reportImportCounts(result: ImportCountsResult, noun: string): void {
    const { imported, skipped, failed } = result;
    if (!imported && !skipped) {
        if (failed) toast.error(unreadableLine(failed, noun));
        else toast.error(`No ${noun}s found in this file`);
        return;
    }
    const parts = [`Imported ${imported} ${noun}${imported === 1 ? '' : 's'}`];
    if (skipped) parts.push(`skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}`);
    if (failed) parts.push(`${failed} unreadable`);
    toast.success(parts.join(', '));
}
