import { toast } from 'sonner';
import type { ImportCountsResult } from '../types/transfer';

// What a file's unreadable members are called, spelled once for the import toast and for the counted
// line a quick look of the same file ends on.
export function unreadableLine(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'} could not be read`;
}

// What a payload holds more of than it lists: contacts, events, attachments, guests.
export function remainingLine(count: number, noun: string): string {
    return `and ${count} more ${noun}${count === 1 ? '' : 's'}`;
}

// The counted lines a typed-payload preview ends on: what the file holds more of than the payload lists
// (derived by the surface as `total - dropped - listed`), and what the parser could not read.
export function previewCountLines(remaining: number, dropped: number, noun: string): string[] {
    return [
        ...(remaining > 0 ? [remainingLine(remaining, noun)] : []),
        ...(dropped > 0 ? [unreadableLine(dropped, noun)] : []),
    ];
}

// The raw body every import route reads: one stream of the file's own bytes, never multipart.
export async function postImportBytes<R>(url: string, contentType: string, file: Blob): Promise<R> {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: file,
        credentials: 'include',
    });
    if (!response.ok) throw new Error(await response.text());
    return await response.json();
}

// A file with no Drive path behind it (a mail part, a chat attachment): the browser carries the bytes
// from the download URL to the import route.
export async function fetchImportBlob(url: string): Promise<Blob> {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(await response.text());
    return await response.blob();
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
