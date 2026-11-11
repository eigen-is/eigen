// The layout of a workbook's Yjs doc: an `ops` log of edit batches, and a `state` map that holds the stored snapshot.
// Its readers and writers, such as the editor, the server's export and compaction or an import, reach the doc through
// these helpers so they agree on that layout.

import type * as Y from 'yjs';
import type { Op } from './types';

// Each entry is one batch of ops, which every reader replays over the snapshot in order.
export function sheetsOpLog(doc: Y.Doc): Y.Array<Op[]> {
    return doc.getArray<Op[]>('ops');
}

export function sheetsStateMap(doc: Y.Doc): Y.Map<unknown> {
    return doc.getMap('state');
}

// The snapshot JSON; undefined before the first snapshot is written.
export function readSheetsSnapshotJson(doc: Y.Doc): string | undefined {
    const snapshot = sheetsStateMap(doc).get('snapshot');
    return typeof snapshot === 'string' ? snapshot : undefined;
}

// Whether the log still opens with these very batches, compared as objects: a batch a peer wrote since is a new object,
// even one equal to a batch here.
export function sheetsLogStartsWith(doc: Y.Doc, batches: readonly Op[][]): boolean {
    const head = sheetsOpLog(doc).slice(0, batches.length);
    return head.length === batches.length && head.every((batch, i) => batch === batches[i]);
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
