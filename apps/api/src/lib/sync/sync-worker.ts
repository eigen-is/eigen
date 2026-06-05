// Process-global coordination for the write-behind upload pipeline (Phase 1b).
//
// The durable queue state lives per-Mount in metadata.db (pending_uploads); the only
// process-global pieces are here: a concurrency limiter shared across all mounts, a
// registry of LIVE mounts with pending work (for the retry sweep), and the shutdown
// deadline. There is deliberately NO global mount/backend registry that survives teardown
// — when a Home idle-destructs, its mount unregisters and its leftover pending rows are
// replayed on the next mount init() (Mount.reconcilePendingUploads). This keeps the worker
// stateless across teardown and leaves the home-relay sharding seam untouched (AGENTS.md).

import { Semaphore } from '../../utils/semaphore';
import { scheduleInterval } from '../scheduler/scheduler';

export interface UploadDrainable {
    readonly id: string;
    drainPendingUploads(opts?: { flushNow?: boolean; deadline?: number }): Promise<void>;
}

// Conservative: piling parallel PUTs onto a throttling provider amplifies a "Slow Down".
export const uploadSemaphore = new Semaphore(4);

const liveMounts = new Set<UploadDrainable>();

export function registerForSync(mount: UploadDrainable): void {
    liveMounts.add(mount);
}

export function unregisterForSync(mount: UploadDrainable): void {
    liveMounts.delete(mount);
}

// Re-drive every live mount's due pending uploads. Backed-off rows become due over time,
// so this is what eventually retries them after an outage without a per-mount timer.
function retrySweep(): void {
    for (const mount of liveMounts) {
        mount.drainPendingUploads().catch((err) => console.error(`[sync] retry sweep failed for ${mount.id}:`, err));
    }
}

export function registerSyncRetrySweep(): void {
    scheduleInterval('sync-retry-sweep', 15_000, retrySweep);
}

// Process shutdown only. When set, Mount.closeAllDatabases flushes its queue (bounded by
// this absolute wall-clock deadline) after the final close-time enqueues but before
// metadata.db closes. Idle teardown leaves this null and skips the flush — leftover
// pending rows replay on the next mount open.
let shutdownDrainDeadline: number | null = null;

export function setShutdownDrainDeadline(deadline: number | null): void {
    shutdownDrainDeadline = deadline;
}

export function getShutdownDrainDeadline(): number | null {
    return shutdownDrainDeadline;
}

// Full-jitter exponential backoff, capped — spreads retries so a recovering backend isn't
// hit by a synchronized thundering herd across many mounts.
export function uploadBackoffMs(attempt: number): number {
    const ceiling = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 10));
    return Math.floor(Math.random() * ceiling);
}
