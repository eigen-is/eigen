// The layout of a workbook's Yjs doc: an `ops` log of edit batches, and a `state` map that holds the stored snapshot
// and the base it starts. Its readers and writers, such as the server's export and compaction, an import or a version
// restore, reach the doc through these helpers so they agree on that layout. A base is a fresh id stamped with each
// new snapshot. A compaction names the base it folded the log into, so a tab can tell a compaction of what it already
// holds from any other new snapshot.

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

// A new snapshot always starts a new base. Only a compaction passes the base it folded; every other writer passes null.
// The snapshot holds every edit the log held, so the log is emptied in the same transaction. A caller that needs an
// origin, such as the compaction, wraps the call in a transaction of its own, which this one joins.
export function writeSheetsSnapshot(doc: Y.Doc, snapshotJson: string, compactedFrom: string | null): void {
    doc.transact(() => {
        sheetsStateMap(doc).set('snapshot', snapshotJson);
        stampSheetsBase(doc, compactedFrom);
        const ops = sheetsOpLog(doc);
        ops.delete(0, ops.length);
    });
}

// For a writer that puts back a snapshot it did not encode, such as a version restore.
export function stampSheetsBase(doc: Y.Doc, compactedFrom: string | null): void {
    const base: SheetsBase = { id: crypto.randomUUID(), compactedFrom };
    sheetsStateMap(doc).set('base', base);
}
