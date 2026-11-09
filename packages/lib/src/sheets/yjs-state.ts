// The layout of a workbook's Yjs doc: an `ops` log of edit batches, and a `state` map that holds the stored snapshot
// and the base it starts. Its readers and writers, such as the server's export and compaction, an import or a version
// restore, reach the doc through these helpers so they agree on that layout. A base is a fresh id stamped with each
// new snapshot. A compaction names the base it folded the log's first batches into, so a tab can tell a compaction of
// what it already holds from any other new snapshot.

import type * as Y from 'yjs';
import { isRecord } from '../core/guards';
import type { Op } from './types';

type SheetsBase = { id: string; compactedFrom: string | null };

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

// Null for a workbook whose snapshot no server writer has stamped yet, or a base a peer wrote in another shape.
export function readSheetsBase(doc: Y.Doc): SheetsBase | null {
    const base = sheetsStateMap(doc).get('base');
    if (!isRecord(base) || typeof base['id'] !== 'string') return null;
    const compactedFrom = base['compactedFrom'];
    return { id: base['id'], compactedFrom: typeof compactedFrom === 'string' ? compactedFrom : null };
}

// Whether the log still opens with these very batches, compared as objects: a batch a peer wrote since is a new object,
// even one equal to a batch here.
export function sheetsLogStartsWith(doc: Y.Doc, batches: readonly Op[][]): boolean {
    const head = sheetsOpLog(doc).slice(0, batches.length);
    return head.length === batches.length && head.every((batch, i) => batch === batches[i]);
}

// A new snapshot always starts a new base. A compaction passes the base it folded and how many of the log's first
// batches the snapshot holds; every other writer passes null, and its snapshot replaces the whole log.
export function writeSheetsSnapshot(
    doc: Y.Doc,
    snapshotJson: string,
    compaction: { compactedFrom: string | null; folded: number } | null,
): void {
    doc.transact(() => {
        sheetsStateMap(doc).set('snapshot', snapshotJson);
        stampSheetsBase(doc, compaction?.compactedFrom ?? null);
        const ops = sheetsOpLog(doc);
        ops.delete(0, compaction?.folded ?? ops.length);
    });
}

// For a writer that puts back a snapshot it did not encode, such as a version restore.
export function stampSheetsBase(doc: Y.Doc, compactedFrom: string | null): void {
    const base: SheetsBase = { id: crypto.randomUUID(), compactedFrom };
    sheetsStateMap(doc).set('base', base);
}
