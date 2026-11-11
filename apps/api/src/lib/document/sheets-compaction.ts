// The main thread's side of a workbook's compaction, which folds the head of the op log into a new snapshot when the
// collab document closes. It decides whether a close compacts, runs the fold in the transform process, and stops
// trying a workbook whose compactions keep failing. The collab document asks for it at the end of its linger, and swaps
// the new snapshot in only while the log still opens with the batches it folded.

import { isCurrentSheetsSnapshot, readSheetsSnapshotJson, sheetsBatchOf, sheetsOpLog } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_SHEETS } from '@workspace/lib/types/drive';
import type * as Y from 'yjs';
import { ApiError } from '../core/errors';
import { runSheetsCompaction, TransformFailedError } from './transform/run-transform';
import { TRANSFORM_LIMITS } from './transform/runner';

// A compaction waits for the one transform child behind whatever holds it, at worst an export, and then runs under its
// own deadline. Past the two together, the document closes without it.
const COMPACTION_BUDGET_MS = TRANSFORM_LIMITS.export.deadlineMs + TRANSFORM_LIMITS.compact.deadlineMs;
// A workbook whose compaction keeps failing, such as one too large for the child's memory, stops trying until the API
// restarts, so it doesn't hold the one child at every close.
const MAX_COMPACTION_FAILURES = 3;
// The failed compactions in a row of each workbook, by its path id. Each open is a new collab document, so the count
// lives here.
const compactionFailures = new Map<string, number>();

// A snapshot in an older format is left as it is. The compaction can't read it, and the editor opens it read-only.
export function sheetsNeedCompaction(path: DrivePath, doc: Y.Doc): boolean {
    if (path.type !== DRIVE_TYPE_SHEETS || sheetsOpLog(doc).length === 0) return false;
    const snapshot = readSheetsSnapshotJson(doc);
    if (snapshot !== undefined && !isCurrentSheetsSnapshot(snapshot)) return false;
    return (compactionFailures.get(path.id) ?? 0) < MAX_COMPACTION_FAILURES;
}

// Null when the run ended without a snapshot. Only a run that failed on the workbook counts toward giving up, never a
// busy runner, a canceled run or a shutdown.
export async function compactSheets(
    path: DrivePath,
    doc: Y.Doc,
    signal: AbortSignal,
): Promise<{ snapshot: string; folded: readonly unknown[] } | null> {
    // Read from the live doc in one step, as data.db can lag behind. The swap compares the entries themselves.
    const log = sheetsOpLog(doc).toArray();
    try {
        const budget = AbortSignal.any([signal, AbortSignal.timeout(COMPACTION_BUDGET_MS)]);
        const { snapshot, dropped, folded } = await runSheetsCompaction(
            readSheetsSnapshotJson(doc) ?? null,
            log.map(sheetsBatchOf),
            budget,
        );
        compactionFailures.delete(path.id);
        if (dropped > 0) {
            console.warn(
                `[sheets] compaction dropped ${dropped} op ${dropped === 1 ? 'batch' : 'batches'} path=${path.id}`,
            );
        }
        return { snapshot, folded: log.slice(0, folded) };
    } catch (err) {
        if (err instanceof ApiError && err.status === 503) return null;
        if (err instanceof TransformFailedError && (err.code === 'canceled' || err.code === 'shutdown')) return null;
        const failures = (compactionFailures.get(path.id) ?? 0) + 1;
        compactionFailures.set(path.id, failures);
        const givesUp = failures === MAX_COMPACTION_FAILURES;
        console.warn(
            `[sheets] compaction failed path=${path.id}${givesUp ? ', gave up until the API restarts' : ''}:`,
            err instanceof Error ? err.message : err,
        );
        return null;
    }
}

// A replacing import or a version restore gives the workbook new content, which gets its own tries.
export function resetSheetsCompactionFailures(path: DrivePath): void {
    compactionFailures.delete(path.id);
}
