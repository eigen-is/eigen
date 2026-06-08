// Process-global coordination for the write-behind upload pipeline (Phase 1b).
//
// Everything here is genuinely process-level and holds NO per-user/per-mount data: a concurrency
// limiter keyed by S3 destination, the backoff function, and the shutdown deadline. The durable
// queue + drain logic is per-mount (see lib/mount/upload-queue.ts) and self-schedules its own
// retries — there is deliberately no global registry of mounts.

import { Semaphore } from '../../utils/semaphore';

// One limiter per S3 destination (endpoint+bucket), NOT one per process. What we protect is a single
// provider's rate limit, so a slow/down destination only backs up its own uploads and never blocks
// uploads to other destinations — essential once team mounts and user-owned endpoints each point at
// different buckets/providers. Keyed by infra strings only; one Semaphore per distinct destination.
const MAX_CONCURRENT_UPLOADS_PER_DESTINATION = 4;
const semaphores = new Map<string, Semaphore>();

export function getUploadSemaphore(destinationKey: string): Semaphore {
    let semaphore = semaphores.get(destinationKey);
    if (!semaphore) {
        semaphore = new Semaphore(MAX_CONCURRENT_UPLOADS_PER_DESTINATION);
        semaphores.set(destinationKey, semaphore);
    }
    return semaphore;
}

// Process shutdown only. Set before shutdownAllHomes; read by Mount.closeAllDatabases, which bounds
// its queue flush by this absolute wall-clock deadline. Idle teardown leaves it null (no flush) — the
// leftover pending rows replay on the next mount open.
let shutdownDrainDeadline: number | null = null;

export function setShutdownDrainDeadline(deadline: number | null): void {
    shutdownDrainDeadline = deadline;
}

export function getShutdownDrainDeadline(): number | null {
    return shutdownDrainDeadline;
}

// Full-jitter exponential backoff, capped — spreads retries so a recovering backend isn't hit by a
// synchronized thundering herd.
export function uploadBackoffMs(attempt: number): number {
    const ceiling = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 10));
    return Math.floor(Math.random() * ceiling);
}
