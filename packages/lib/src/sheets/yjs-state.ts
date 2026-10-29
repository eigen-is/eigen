// The layout of a workbook's Yjs `state` map, which holds the stored snapshot and the base it starts. Every reader and
// writer of that map goes through here, such as the server's export and compaction, an import, a version restore and
// the editor tab. A base is a fresh id stamped with each new snapshot. A compaction names the base it folded the log
// into, so a tab can tell a compaction of what it already holds from any other new snapshot.

import type * as Y from 'yjs';
import { isRecord } from '../core/guards';

export type SheetsBase = { id: string; compactedFrom: string | null };

// The snapshot JSON; undefined before the first snapshot is written.
export function readSheetsSnapshotJson(doc: Y.Doc): string | undefined {
    const snapshot = doc.getMap('state').get('snapshot');
    return typeof snapshot === 'string' ? snapshot : undefined;
}

// Null for a workbook whose snapshot no server writer has stamped yet, or a base a peer wrote in another shape.
export function readSheetsBase(doc: Y.Doc): SheetsBase | null {
    const base = doc.getMap('state').get('base');
    if (!isRecord(base) || typeof base['id'] !== 'string') return null;
    const compactedFrom = base['compactedFrom'];
    return { id: base['id'], compactedFrom: typeof compactedFrom === 'string' ? compactedFrom : null };
}

// A new snapshot always starts a new base. Only a compaction passes the base it folded; every other writer passes null.
export function writeSheetsSnapshot(doc: Y.Doc, snapshotJson: string, compactedFrom: string | null): void {
    doc.transact(() => {
        doc.getMap('state').set('snapshot', snapshotJson);
        stampSheetsBase(doc, compactedFrom);
    });
}

// For a writer that puts back a snapshot it did not encode, such as a version restore.
export function stampSheetsBase(doc: Y.Doc, compactedFrom: string | null): void {
    const base: SheetsBase = { id: crypto.randomUUID(), compactedFrom };
    doc.getMap('state').set('base', base);
}
