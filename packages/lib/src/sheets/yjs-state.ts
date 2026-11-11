// The layout of a workbook's Yjs doc: an `ops` log of edit batches, and a `state` map that holds the stored snapshot.
// Its readers and writers, such as the editor, the server's export and compaction or an import, reach the doc through
// these helpers so they agree on that layout, and on which of a peer's log entries is a batch at all.

import type * as Y from 'yjs';
import type { Op } from './types';
import { isOpBatch } from './types';

// Each entry is one batch of ops, which every reader replays over the snapshot in order. A peer can store anything as
// an entry, so a reader takes its batches from readSheetsLog or sheetsBatchOf.
export function sheetsOpLog(doc: Y.Doc): Y.Array<unknown> {
    return doc.getArray('ops');
}

// The log's batches from index `from` on, each at its entry's place.
export function readSheetsLog(doc: Y.Doc, from = 0): Op[][] {
    return sheetsOpLog(doc).slice(from).map(sheetsBatchOf);
}

// A log entry as the batch every reader applies. One that is no batch of well-formed ops reads as an empty batch, so
// it changes nothing and the batches after it keep their places in the log.
export function sheetsBatchOf(entry: unknown): Op[] {
    return isOpBatch(entry) ? entry : [];
}

export function sheetsStateMap(doc: Y.Doc): Y.Map<unknown> {
    return doc.getMap('state');
}

// The snapshot JSON; undefined before the first snapshot is written.
export function readSheetsSnapshotJson(doc: Y.Doc): string | undefined {
    const snapshot = sheetsStateMap(doc).get('snapshot');
    return typeof snapshot === 'string' ? snapshot : undefined;
}

// Whether the log still opens with these very entries, compared as objects: a batch a peer wrote since is a new object,
// even one equal to a batch here.
export function sheetsLogStartsWith(doc: Y.Doc, entries: readonly unknown[]): boolean {
    const head = sheetsOpLog(doc).slice(0, entries.length);
    return head.length === entries.length && head.every((entry, i) => entry === entries[i]);
}

// A compaction passes how many of the log's first batches the snapshot holds. Every other writer passes null, and its
// snapshot replaces the whole log.
export function writeSheetsSnapshot(doc: Y.Doc, snapshotJson: string, folded: number | null): void {
    doc.transact(() => {
        sheetsStateMap(doc).set('snapshot', snapshotJson);
        const ops = sheetsOpLog(doc);
        ops.delete(0, folded ?? ops.length);
    });
}
