import { ApiError } from '../../core/errors';
import {
    type DocumentTransformRequest,
    type DocumentTransformResponse,
    type ExportWorkerResult,
    type PreviewResult,
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

export const PREVIEW_TRANSFORM_DEADLINE_MS = 30_000;
// Heavy but user-requested work; the PDF subprocess keeps its own deadline.
export const EXPORT_TRANSFORM_DEADLINE_MS = 120_000;

const MAX_ACTIVE_WORKERS = 1;
const MAX_QUEUED_JOBS = 16;
// A queued request holds its HTTP connection open, so foreground admission is
// bounded by predicted wait (summed worst-case deadlines), not queue length alone.
const MAX_PREDICTED_WAIT_MS = 120_000;
const CLOSE_GRACE_MS = 5_000;
// Shown verbatim by useExportDocument's error toast — keep it human-readable.
const BUSY_MESSAGE = 'The server is busy, please try again in a moment';

// captureMs: main-thread source-capture time measured by the caller — logged per
// job because a fast Worker time with a slow capture is not a successful offload.
type RunOptions = { priority: TransformPriority; deadlineMs: number; captureMs?: number; signal?: AbortSignal };

type Job = {
    id: number;
    request: DocumentTransformRequest;
    priority: TransformPriority;
    deadlineMs: number;
    captureMs?: number;
    enqueuedAt: number;
    resolve: (response: DocumentTransformResponse) => void;
};

type ActiveJob = { settle: (response: DocumentTransformResponse) => void; deadlineMs: number };

function errorResponse(code: TransformError['code'], message: string): DocumentTransformResponse {
    return { ok: false, error: { code, message } };
}

// Full shape check at the trust boundary: a half-valid response (`{ok: true}`
// with no result, or a result that doesn't match the request kind) must become a
// structured invalid-response, not a throw inside settle that leaves the
// requester's promise hanging forever.
function isValidResponse(
    response: unknown,
    kind: DocumentTransformRequest['kind'],
): response is DocumentTransformResponse {
    if (!response || typeof response !== 'object') return false;
    const r = response as {
        ok?: unknown;
        result?: { body?: unknown; data?: unknown };
        warnings?: unknown;
        error?: { code?: unknown; message?: unknown };
    };
    if (r.ok === true) {
        if (!Array.isArray(r.warnings)) return false;
        return kind === 'preview' ? typeof r.result?.body === 'string' : r.result?.data instanceof ArrayBuffer;
    }
    if (r.ok === false) return typeof r.error?.code === 'string' && typeof r.error?.message === 'string';
    return false;
}

function resultBytes(result: PreviewResult | ExportWorkerResult): number {
    return 'body' in result ? Buffer.byteLength(result.body) : result.data.byteLength;
}

export class DocumentTransformRunner {
    private readonly workerUrl: string;
    private readonly maxQueued: number;
    private readonly maxPredictedWaitMs: number;
    private readonly closeGraceMs: number;
    private foreground: Job[] = [];
    private background: Job[] = [];
    private active = new Map<number, ActiveJob>();
    private nextJobId = 1;
    private closing = false;

    constructor(
        opts: { workerUrl?: string; maxQueued?: number; maxPredictedWaitMs?: number; closeGraceMs?: number } = {},
    ) {
        this.workerUrl = opts.workerUrl ?? new URL('./worker', import.meta.url).href;
        this.maxQueued = opts.maxQueued ?? MAX_QUEUED_JOBS;
        this.maxPredictedWaitMs = opts.maxPredictedWaitMs ?? MAX_PREDICTED_WAIT_MS;
        this.closeGraceMs = opts.closeGraceMs ?? CLOSE_GRACE_MS;
    }

    // Throws ApiError(503) synchronously when the job cannot be admitted; the
    // returned promise always resolves with a DocumentTransformResponse.
    run(request: DocumentTransformRequest, opts: RunOptions): Promise<DocumentTransformResponse> {
        if (this.closing) throw new ApiError(503, BUSY_MESSAGE);
        if (this.foreground.length + this.background.length >= this.maxQueued) throw new ApiError(503, BUSY_MESSAGE);
        if (opts.priority === 'foreground') {
            let predictedWaitMs = this.foreground.reduce((sum, job) => sum + job.deadlineMs, 0);
            for (const active of this.active.values()) predictedWaitMs += active.deadlineMs;
            if (predictedWaitMs > this.maxPredictedWaitMs) throw new ApiError(503, BUSY_MESSAGE);
        }

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
                captureMs: opts.captureMs,
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
                `[transform] job=${job.id} kind=${job.request.kind} type=${job.request.documentType} ` +
                    `priority=${job.priority} outcome=${outcome} queueDepth=${queueDepth} queueWaitMs=${queueWaitMs} ` +
                    `captureMs=${job.captureMs?.toFixed(0) ?? -1} inputBytes=${inputBytes} ` +
                    `transformMs=${transformMs?.toFixed(0) ?? -1} totalMs=${totalMs} outputBytes=${outputBytes}` +
                    (warnings ? ` warnings=${warnings.map((warning) => warning.code).join(',')}` : ''),
            );
            job.resolve(response);
            this.startNext();
        };
        this.active.set(job.id, { settle, deadlineMs: job.deadlineMs });

        const timer = setTimeout(
            () => settle(errorResponse('timeout', 'Document transform timed out')),
            job.deadlineMs,
        );
        worker.onmessage = (event: MessageEvent) => {
            const envelope = event.data as Partial<WorkerResponseEnvelope> | null;
            const response = envelope?.response;
            if (!isValidResponse(response, job.request.kind)) {
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
