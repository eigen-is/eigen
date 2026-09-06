import { ApiError } from '../../core/errors';
import {
    type DocumentTransformRequest,
    type DocumentTransformResponse,
    resultBytes,
    resultMatchesRequest,
    type TransformError,
    type TransformWarning,
    transferListOf,
    type WorkerResponseEnvelope,
} from './protocol';

// Process-wide runner for document-transform Workers. Owns admission and Worker
// lifecycle only — document logic lives in worker.ts and the format modules it
// dynamically imports. Deliberately a "runner", not a scheduler: lib/scheduler/
// owns periodic jobs; the closest sibling shape is ContentReindexQueue.
//
// Policy (docs/DOCUMENT-TRANSFORMS.md § Worker lifecycle): one active Worker so a
// single ExcelJS/Yjs heap exists at a time, a bounded queue with two priorities, one-shot
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

// Each arm of the closed warning union carries exactly one payload field; settle()
// renders them after the job left `active`, so an unknown code or a missing payload
// has to be refused here rather than throw with nobody left to settle the request.
// Keyed by the union so a future arm is a compile error here — a switch default
// would silently turn every success carrying the new warning into invalid-response.
const WARNING_VALIDATORS: Record<TransformWarning['code'], (w: Record<string, unknown>) => boolean> = {
    'recalc-failed': (w) => typeof w['message'] === 'string',
    'corrupt-blobs-skipped': (w) => typeof w['count'] === 'number',
    'byte-guard-truncated': (w) => typeof w['bytes'] === 'number',
};

function isValidWarning(warning: unknown): boolean {
    if (!warning || typeof warning !== 'object') return false;
    const w = warning as Record<string, unknown>;
    const code = w['code'];
    const validate = typeof code === 'string' && WARNING_VALIDATORS[code as TransformWarning['code']];
    return validate ? validate(w) : false;
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
        error?: { code?: unknown; message?: unknown; status?: unknown };
    };
    if (r.ok === true) {
        return Array.isArray(r.warnings) && r.warnings.every(isValidWarning) && resultMatchesRequest(request, r.result);
    }
    if (r.ok === false) {
        // `status` becomes the HTTP status the main thread throws (run-transform.ts) —
        // only an error-range integer may cross.
        const status = r.error?.status;
        return (
            typeof r.error?.code === 'string' &&
            typeof r.error?.message === 'string' &&
            (status === undefined ||
                (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599))
        );
    }
    return false;
}

// An import has no source document type — log the type it produces.
function requestType(request: DocumentTransformRequest): string {
    return request.kind === 'import' ? request.targetType : request.documentType;
}

// Exports log the format they render, imports the format they read; previews and
// extracts have none.
function requestFormat(request: DocumentTransformRequest): string {
    if (request.kind === 'export') return request.format;
    if (request.kind === 'import') return request.sourceFormat;
    return '-';
}

// The count/bytes a warning carries is the diagnostic — a bare code hides how many
// blobs were skipped. recalc-failed's message stays out of the logs: it can quote
// document content.
function formatWarning(warning: TransformWarning): string {
    if ('count' in warning) return `${warning.code}:${warning.count}`;
    if ('bytes' in warning) return `${warning.code}:${warning.bytes}`;
    return warning.code;
}

export class DocumentTransformRunner {
    private readonly workerUrl: string;
    // Production always runs the constants above; only the runner suite dials these down.
    private readonly maxQueued = MAX_QUEUED_JOBS;
    private readonly maxQueuedBackground = MAX_QUEUED_BACKGROUND;
    private readonly maxPredictedWaitMs = MAX_PREDICTED_WAIT_MS;
    private readonly closeGraceMs = CLOSE_GRACE_MS;
    private foreground: Job[] = [];
    private background: Job[] = [];
    private active = new Map<number, ActiveJob>();
    private nextJobId = 1;
    private closing = false;

    constructor(opts: { workerUrl?: string } = {}) {
        this.workerUrl = opts.workerUrl ?? new URL('./worker', import.meta.url).href;
    }

    // Throws ApiError(503) synchronously when the job cannot be admitted. Callable
    // ahead of run() so a caller can refuse before paying for an expensive input
    // (run-transform.ts checks it before capturing the document).
    assertAdmissible(priority: TransformPriority): void {
        if (this.closing) this.refuse(priority, 'closing');
        if (this.foreground.length + this.background.length >= this.maxQueued) this.refuse(priority, 'queue-full');
        if (priority === 'background' && this.background.length >= this.maxQueuedBackground) {
            this.refuse(priority, 'background-share');
        }
        if (priority === 'foreground') {
            let predictedWaitMs = this.foreground.reduce((sum, job) => sum + job.admissionCostMs, 0);
            for (const active of this.active.values()) predictedWaitMs += active.admissionCostMs;
            if (predictedWaitMs > this.maxPredictedWaitMs) this.refuse(priority, 'predicted-wait', predictedWaitMs);
        }
    }

    // Overload is an outcome too (DOCUMENT-TRANSFORMS.md § Observability): a 503 flood
    // must be visible in the logs, with the queue state that caused it.
    private refuse(priority: TransformPriority, reason: string, predictedWaitMs?: number): never {
        console.warn(
            `[transform] admission refused reason=${reason} priority=${priority} ` +
                `queueDepth=${this.foreground.length + this.background.length}` +
                (predictedWaitMs === undefined ? '' : ` predictedWaitMs=${predictedWaitMs}`),
        );
        throw new ApiError(503, BUSY_MESSAGE);
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
        let worker: Worker | undefined;
        let transformMs: number | undefined;

        const settle = (response: DocumentTransformResponse) => {
            if (!this.active.has(job.id)) return;
            this.active.delete(job.id);
            clearTimeout(timer);
            worker?.terminate();
            const totalMs = Date.now() - startedAt;
            const outcome = response.ok ? 'success' : response.error.code;
            const outputBytes = response.ok ? resultBytes(response.result) : 0;
            const warnings = response.ok && response.warnings.length > 0 ? response.warnings : null;
            // The Worker stamps transform-only time, so the rest of the job is spawn,
            // module evaluation and messaging — the one-shot cost worth watching. Clamped:
            // totalMs is whole-ms while the Worker's stamp is fractional, and -1 is taken.
            const startupMs = transformMs === undefined ? -1 : Math.max(0, Math.round(totalMs - transformMs));
            console.log(
                `[transform] job=${job.id} kind=${job.request.kind} type=${requestType(job.request)} ` +
                    `format=${requestFormat(job.request)} priority=${job.priority} outcome=${outcome} ` +
                    `queueDepth=${queueDepth} queueWaitMs=${queueWaitMs} ` +
                    `captureMs=${job.captureMs?.toFixed(0) ?? -1} prepMs=${job.prepMs?.toFixed(0) ?? -1} ` +
                    `inputBytes=${inputBytes} startupMs=${startupMs} ` +
                    `transformMs=${transformMs?.toFixed(0) ?? -1} totalMs=${totalMs} outputBytes=${outputBytes}` +
                    (warnings ? ` warnings=${warnings.map(formatWarning).join(',')}` : ''),
            );
            job.resolve(response);
            this.startNext();
        };
        this.active.set(job.id, { settle, admissionCostMs: job.admissionCostMs });

        const timer = setTimeout(
            () => settle(errorResponse('timeout', 'Document transform timed out')),
            job.deadlineMs,
        );
        // Spawning and posting can throw synchronously (a failed spawn under resource
        // exhaustion, a DataCloneError on a detached transfer buffer). Unhandled, that
        // holds the only Worker slot until the deadline and escapes into run()'s
        // executor — rejecting a promise that is documented to always resolve.
        try {
            worker = new Worker(this.workerUrl);
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
        } catch (err) {
            console.error(`[transform] job=${job.id} worker start failed:`, err);
            settle(errorResponse('crashed', 'Document transform failed'));
        }
    }
}

export const documentTransformRunner = new DocumentTransformRunner();
