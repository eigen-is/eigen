import { ApiError } from '../../core/errors';
import {
    type DocumentTransformRequest,
    type DocumentTransformResponse,
    resultBytes,
    resultMatchesRequest,
    type TransformError,
    transferListOf,
    type WorkerResponseEnvelope,
} from './protocol';

// Process-wide runner for document-transform Workers. Owns admission and Worker
// lifecycle only — document logic lives in worker.ts and the format modules it
// dynamically imports. Deliberately a "runner", not a scheduler: lib/scheduler/
// owns periodic jobs; the closest sibling shape is ContentReindexQueue.
//
// Policy (proposal § Runner and Worker lifetime): one active Worker so a single
// ExcelJS/Yjs heap exists at a time, a bounded queue with two priorities, one-shot
// Workers terminated after every outcome, and NEVER a main-thread fallback — an
// overloaded or failing runner must not reintroduce the event-loop freeze it
// exists to remove.

export type TransformPriority = 'foreground' | 'background';

// What each operation runs under: `deadlineMs` is the kill deadline that bounds
// runaways, `admissionCostMs` what the job is expected to cost the queue (~10–20× the
// worst measured end-to-end time, deliberately decoupled from the deadline, which
// bounds runaways rather than typical wait).
export const TRANSFORM_LIMITS: Record<
    DocumentTransformRequest['kind'],
    Pick<RunOptions, 'deadlineMs' | 'admissionCostMs'>
> = {
    preview: { deadlineMs: 30_000, admissionCostMs: 15_000 },
    // Heavy but user-requested work (exports, imports and conversions); the PDF
    // subprocess keeps its own deadline.
    export: { deadlineMs: 120_000, admissionCostMs: 30_000 },
    import: { deadlineMs: 120_000, admissionCostMs: 30_000 },
    // Search reindexing: nobody waits on it, but a stuck job must not hold the single
    // active Worker away from user-facing work. It reuses the preview cost.
    'extract-text': { deadlineMs: 30_000, admissionCostMs: 15_000 },
};

const MAX_ACTIVE_WORKERS = 1;
const MAX_QUEUED_JOBS = 16;
// Background extracts hold no connection and are drop-safe (the contentDirty bit
// re-queues them), so they may hold only part of the queue: many mounts draining at
// once must not 503 the previews and exports someone is waiting for.
const MAX_QUEUED_BACKGROUND = 8;
// A queued request holds its HTTP connection open, so foreground admission is
// bounded by predicted wait (summed admission costs), not queue length alone.
const MAX_PREDICTED_WAIT_MS = 120_000;
const CLOSE_GRACE_MS = 5_000;
// Shown verbatim by useExportDocument's error toast — keep it human-readable.
const BUSY_MESSAGE = 'The server is busy, please try again in a moment';

// captureMs / prepMs: main-thread source-capture and media-preparation time measured
// by the caller — logged per job because a fast Worker time with slow main-thread
// preparation is not a successful offload.
export type RunOptions = {
    priority: TransformPriority;
    deadlineMs: number;
    admissionCostMs: number;
    captureMs?: number;
    prepMs?: number;
    signal?: AbortSignal;
};

type Job = {
    id: number;
    request: DocumentTransformRequest;
    priority: TransformPriority;
    deadlineMs: number;
    admissionCostMs: number;
    captureMs?: number;
    prepMs?: number;
    enqueuedAt: number;
    resolve: (response: DocumentTransformResponse) => void;
};

type ActiveJob = { settle: (response: DocumentTransformResponse) => void; admissionCostMs: number };

function errorResponse(code: TransformError['code'], message: string): DocumentTransformResponse {
    return { ok: false, error: { code, message } };
}

// Full shape check at the trust boundary: a half-valid response (`{ok: true}`
// with no result, or a result that doesn't match the request kind) must become a
// structured invalid-response, not a throw inside settle that leaves the
// requester's promise hanging forever.
function isValidResponse(response: unknown, request: DocumentTransformRequest): response is DocumentTransformResponse {
    if (!response || typeof response !== 'object') return false;
    const r = response as {
        ok?: unknown;
        result?: unknown;
        warnings?: unknown;
        error?: { code?: unknown; message?: unknown };
    };
    if (r.ok === true) return Array.isArray(r.warnings) && resultMatchesRequest(request, r.result);
    if (r.ok === false) return typeof r.error?.code === 'string' && typeof r.error?.message === 'string';
    return false;
}

// An import has no source document type — log the type it produces.
function requestType(request: DocumentTransformRequest): string {
    return request.kind === 'import' ? request.targetType : request.documentType;
}

export class DocumentTransformRunner {
    private readonly workerUrl: string;
    private readonly maxQueued: number;
    private readonly maxQueuedBackground: number;
    private readonly maxPredictedWaitMs: number;
    private readonly closeGraceMs: number;
    private foreground: Job[] = [];
    private background: Job[] = [];
    private active = new Map<number, ActiveJob>();
    private nextJobId = 1;
    private closing = false;

    constructor(
        opts: {
            workerUrl?: string;
            maxQueued?: number;
            maxQueuedBackground?: number;
            maxPredictedWaitMs?: number;
            closeGraceMs?: number;
        } = {},
    ) {
        this.workerUrl = opts.workerUrl ?? new URL('./worker', import.meta.url).href;
        this.maxQueued = opts.maxQueued ?? MAX_QUEUED_JOBS;
        this.maxQueuedBackground = opts.maxQueuedBackground ?? MAX_QUEUED_BACKGROUND;
        this.maxPredictedWaitMs = opts.maxPredictedWaitMs ?? MAX_PREDICTED_WAIT_MS;
        this.closeGraceMs = opts.closeGraceMs ?? CLOSE_GRACE_MS;
    }

    // Throws ApiError(503) synchronously when the job cannot be admitted. Callable
    // ahead of run() so a caller can refuse before paying for an expensive input
    // (run-transform.ts checks it before capturing the document).
    assertAdmissible(priority: TransformPriority): void {
        if (this.closing) throw new ApiError(503, BUSY_MESSAGE);
        if (this.foreground.length + this.background.length >= this.maxQueued) throw new ApiError(503, BUSY_MESSAGE);
        if (priority === 'background' && this.background.length >= this.maxQueuedBackground) {
            throw new ApiError(503, BUSY_MESSAGE);
        }
        if (priority === 'foreground') {
            let predictedWaitMs = this.foreground.reduce((sum, job) => sum + job.admissionCostMs, 0);
            for (const active of this.active.values()) predictedWaitMs += active.admissionCostMs;
            if (predictedWaitMs > this.maxPredictedWaitMs) throw new ApiError(503, BUSY_MESSAGE);
        }
    }

    // Throws ApiError(503) synchronously when the job cannot be admitted; the
    // returned promise always resolves with a DocumentTransformResponse.
    run(request: DocumentTransformRequest, opts: RunOptions): Promise<DocumentTransformResponse> {
        this.assertAdmissible(opts.priority);

        return new Promise((resolve) => {
            if (opts.signal?.aborted) {
                resolve(errorResponse('canceled', 'Request was canceled'));
                return;
            }
            const job: Job = {
                id: this.nextJobId++,
                request,
                priority: opts.priority,
                deadlineMs: opts.deadlineMs,
                admissionCostMs: opts.admissionCostMs,
                captureMs: opts.captureMs,
                prepMs: opts.prepMs,
                enqueuedAt: Date.now(),
                resolve,
            };
            const queue = opts.priority === 'foreground' ? this.foreground : this.background;
            queue.push(job);
            opts.signal?.addEventListener('abort', () => this.cancel(job), { once: true });
            this.startNext();
        });
    }

    // Server shutdown: stop admission, reject queued work, give active Workers a
    // short grace period, then terminate them.
    async close(): Promise<void> {
        this.closing = true;
        const queued = [...this.foreground, ...this.background];
        this.foreground = [];
        this.background = [];
        for (const job of queued) job.resolve(errorResponse('shutdown', 'Server is shutting down'));
        const deadline = Date.now() + this.closeGraceMs;
        while (this.active.size > 0 && Date.now() < deadline) await Bun.sleep(10);
        for (const active of [...this.active.values()]) {
            active.settle(errorResponse('shutdown', 'Server is shutting down'));
        }
    }

    private cancel(job: Job): void {
        const queue = job.priority === 'foreground' ? this.foreground : this.background;
        const index = queue.indexOf(job);
        if (index >= 0) {
            queue.splice(index, 1);
            job.resolve(errorResponse('canceled', 'Request was canceled'));
            return;
        }
        this.active.get(job.id)?.settle(errorResponse('canceled', 'Request was canceled'));
    }

    private startNext(): void {
        while (this.active.size < MAX_ACTIVE_WORKERS && !this.closing) {
            const job = this.foreground.shift() ?? this.background.shift();
            if (!job) return;
            this.runJob(job);
        }
    }

    private runJob(job: Job): void {
        const queueWaitMs = Date.now() - job.enqueuedAt;
        const queueDepth = this.foreground.length + this.background.length;
        const transferList = transferListOf(job.request);
        // Summed before postMessage — the transfer detaches these buffers.
        const inputBytes = transferList.reduce((sum, buffer) => sum + buffer.byteLength, 0);
        const startedAt = Date.now();
        const worker = new Worker(this.workerUrl);
        let transformMs: number | undefined;

        const settle = (response: DocumentTransformResponse) => {
            if (!this.active.has(job.id)) return;
            this.active.delete(job.id);
            clearTimeout(timer);
            worker.terminate();
            const totalMs = Date.now() - startedAt;
            const outcome = response.ok ? 'success' : response.error.code;
            const outputBytes = response.ok ? resultBytes(response.result) : 0;
            const warnings = response.ok && response.warnings.length > 0 ? response.warnings : null;
            console.log(
                `[transform] job=${job.id} kind=${job.request.kind} type=${requestType(job.request)} ` +
                    `priority=${job.priority} outcome=${outcome} queueDepth=${queueDepth} queueWaitMs=${queueWaitMs} ` +
                    `captureMs=${job.captureMs?.toFixed(0) ?? -1} prepMs=${job.prepMs?.toFixed(0) ?? -1} ` +
                    `inputBytes=${inputBytes} ` +
                    `transformMs=${transformMs?.toFixed(0) ?? -1} totalMs=${totalMs} outputBytes=${outputBytes}` +
                    (warnings ? ` warnings=${warnings.map((warning) => warning.code).join(',')}` : ''),
            );
            job.resolve(response);
            this.startNext();
        };
        this.active.set(job.id, { settle, admissionCostMs: job.admissionCostMs });

        const timer = setTimeout(
            () => settle(errorResponse('timeout', 'Document transform timed out')),
            job.deadlineMs,
        );
        worker.onmessage = (event: MessageEvent) => {
            const envelope = event.data as Partial<WorkerResponseEnvelope> | null;
            const response = envelope?.response;
            if (!isValidResponse(response, job.request)) {
                settle(errorResponse('invalid-response', 'Worker returned a malformed response'));
                return;
            }
            transformMs = typeof envelope?.transformMs === 'number' ? envelope.transformMs : undefined;
            settle(response);
        };
        worker.onerror = (event) => {
            console.error(`[transform] job=${job.id} worker error:`, event.message || event);
            settle(errorResponse('crashed', 'Document transform failed'));
        };
        worker.addEventListener('close', () => settle(errorResponse('crashed', 'Document transform failed')));
        worker.postMessage({ jobId: job.id, request: job.request }, transferList);
    }
}

export const documentTransformRunner = new DocumentTransformRunner();
