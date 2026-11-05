// The API's one runner of document-transform child processes: it admits jobs into a bounded queue with two priorities
// and runs one child at a time, so one Yjs heap exists at once. Each child serves one job and is killed after it. An
// overloaded or failing runner refuses with a 503 and never falls back to the main thread, whose event-loop freeze it
// exists to remove. The previews, exports, imports and the search reindex, for example, run their documents through it.

import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Subprocess } from 'bun';
import { ApiError } from '../../core/errors';
import type {
    ChildAck,
    ChildMediaRequest,
    ChildResponseEnvelope,
    DocumentTransformRequest,
    DocumentTransformResponse,
    ExportMedia,
    ParentMediaReply,
    TransformError,
    TransformWarning,
} from './protocol';
import { inputBytesOf, resultBytes, toTransformError } from './protocol';

export type TransformPriority = 'foreground' | 'background';

// Each kind's kill deadline, which bounds a runaway, and its admission cost, what it is expected to take from the queue.
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
    // active child away from user-facing work. It reuses the preview cost.
    'extract-text': { deadlineMs: 30_000, admissionCostMs: 15_000 },
    // A workbook's log folded at its close: a decode, a replay and an encode, less than an export does. It runs in the
    // background and holds the one child, so it gets a preview's cost and room for a large workbook.
    compact: { deadlineMs: 60_000, admissionCostMs: 15_000 },
    // A read of what a document's current state names, before a sweep. It is a materialize and a walk,
    // so it gets a compaction's limits.
    references: { deadlineMs: 60_000, admissionCostMs: 15_000 },
};

const MAX_ACTIVE_CHILDREN = 1;
const MAX_QUEUED_JOBS = 16;
// Background work may hold only part of the queue, so a mass reindex can't 503 the jobs someone waits for.
const MAX_QUEUED_BACKGROUND = 8;
const MAX_PREDICTED_WAIT_MS = 120_000;
const CLOSE_GRACE_MS = 5_000;
// A killed child stuck in the kernel can't exit, and must not hold the shutdown.
const KILL_WAIT_MS = 1_000;
// The client shows it word for word, so it stays readable for a person.
export const BUSY_MESSAGE = 'The server is busy, please try again in a moment';

// Linux alone takes these limits, as macOS refuses setrlimit for the data segment. $1 is the data segment in KiB, $2
// the CPU seconds, and the rest is the command.
const LIMITED_COMMAND =
    'echo 1000 > /proc/self/oom_score_adj; echo 0 > /proc/self/coredump_filter; ulimit -d "$1" 2>/dev/null || echo "memory limit not applied" >&2; ulimit -St "$2"; ulimit -c 0; shift 2; exec "$@"';
// GC and JIT threads spend CPU on every core beside the job's own, so the CPU limit is the deadline on each, plus slack.
const CPU_SLACK_SECONDS = 60;
// The machine's memory, or the cgroup's where there is one, as Bun's constrainedMemory() answers both. A child never
// claims more memory than there is.
const MACHINE_MEMORY_KIB = Math.floor(process.constrainedMemory() / 1024);
// JSC reserves 512 MB for JIT code inside the data limit; 64 MB hands about 0.33 GB back to the heap, no slowdown measured.
const JIT_RESERVATION_BYTES = '67108864';
// A heap allocation JSC can't satisfy aborts the child, faults it or traps it (x86-64's crash), and the kernel's OOM
// killer sends SIGKILL.
const OUT_OF_MEMORY_SIGNALS = new Set<number | NodeJS.Signals>(['SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGTRAP', 'SIGKILL']);

// captureMs and prepMs are the caller's main-thread time before the job, for its log line. prepareMedia answers an
// export child that asks for the media its document names, and its signal aborts once the job ends.
export type RunOptions = {
    priority: TransformPriority;
    deadlineMs: number;
    admissionCostMs: number;
    captureMs?: number;
    prepMs?: number;
    prepareMedia?: (names: string[], signal: AbortSignal) => Promise<ExportMedia[]>;
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
    prepareMedia?: RunOptions['prepareMedia'];
    enqueuedAt: number;
    resolve: (response: DocumentTransformResponse) => void;
};

// Why the runner killed a child itself.
type RunnerKill = 'timeout' | 'canceled' | 'shutdown';
type ChildOutcome = RunnerKill | 'out-of-memory' | 'crashed';

type ActiveJob = {
    kill: (reason: RunnerKill) => void;
    settle: (response: DocumentTransformResponse) => void;
    admissionCostMs: number;
};

const OUTCOME_MESSAGES: Record<ChildOutcome, string> = {
    timeout: 'Document transform timed out',
    canceled: 'Request was canceled',
    shutdown: 'Server is shutting down',
    'out-of-memory': 'Document transform ran out of memory',
    crashed: 'Document transform failed',
};

function errorResponse(code: TransformError['code'], message: string): DocumentTransformResponse {
    return { ok: false, error: { code, message } };
}

function failed(outcome: ChildOutcome): DocumentTransformResponse {
    return errorResponse(outcome, OUTCOME_MESSAGES[outcome]);
}

// How a child that ended without a reply ended. A death after it took the job is the job's memory; one before it, or
// by any other signal or exit, is a crash: a broken install is not a file too large.
function childOutcome(
    signal: number | NodeJS.Signals | null,
    killedBy: RunnerKill | undefined,
    acked: boolean,
): ChildOutcome {
    if (killedBy) return killedBy;
    if (acked && signal && OUT_OF_MEMORY_SIGNALS.has(signal)) return 'out-of-memory';
    return 'crashed';
}

// The heavy processes the API spawns, the transform child and WeasyPrint, run under the same limits.
export function limitedCommand(command: string[], deadlineMs: number, memoryLimitKiB = MACHINE_MEMORY_KIB): string[] {
    if (process.platform !== 'linux') return command;
    const cpuSeconds = Math.ceil(deadlineMs / 1000) * availableParallelism() + CPU_SLACK_SECONDS;
    return ['/bin/sh', '-c', LIMITED_COMMAND, 'sh', String(memoryLimitKiB), String(cpuSeconds), ...command];
}

// An import has no source document type, so it logs the type it produces.
function requestType(request: DocumentTransformRequest): string {
    return request.kind === 'import' ? request.targetType : request.documentType;
}

function requestFormat(request: DocumentTransformRequest): string {
    if (request.kind === 'export') return request.format;
    if (request.kind === 'import') return request.sourceFormat;
    return '-';
}

// The count or the bytes a warning carries is the diagnostic, since a bare code hides how many blobs were skipped.
// recalc-failed's message stays out of the logs, because it can quote document content.
function formatWarning(warning: TransformWarning): string {
    if ('count' in warning) return `${warning.code}:${warning.count}`;
    if ('bytes' in warning) return `${warning.code}:${warning.bytes}`;
    return warning.code;
}

export class DocumentTransformRunner {
    private readonly entry: string;
    // Production always runs the constants above; only the runner suite dials these down.
    private readonly maxQueued = MAX_QUEUED_JOBS;
    private readonly maxQueuedBackground = MAX_QUEUED_BACKGROUND;
    private readonly maxPredictedWaitMs = MAX_PREDICTED_WAIT_MS;
    private readonly closeGraceMs = CLOSE_GRACE_MS;
    private readonly memoryLimitKiB = MACHINE_MEMORY_KIB;
    private foreground: Job[] = [];
    private background: Job[] = [];
    private readonly active = new Map<number, ActiveJob>();
    private nextJobId = 1;
    private closing = false;

    public constructor(opts: { entry?: string } = {}) {
        this.entry = opts.entry ?? fileURLToPath(new URL('./child', import.meta.url));
    }

    // Callable ahead of run(), so a caller can refuse before it pays for an expensive input.
    public assertAdmissible(priority: TransformPriority): void {
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

    // Overload is an outcome too, so a flood of 503s shows in the logs with the queue state that caused it.
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
    public run(request: DocumentTransformRequest, opts: RunOptions): Promise<DocumentTransformResponse> {
        this.assertAdmissible(opts.priority);

        return new Promise((resolve) => {
            if (opts.signal?.aborted) {
                resolve(failed('canceled'));
                return;
            }
            // The caller's prep spent the whole deadline: a child spawned now would only be killed.
            if (opts.deadlineMs <= 0) {
                resolve(failed('timeout'));
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
                prepareMedia: opts.prepareMedia,
                enqueuedAt: Date.now(),
                resolve,
            };
            const queue = opts.priority === 'foreground' ? this.foreground : this.background;
            queue.push(job);
            opts.signal?.addEventListener('abort', () => this.cancel(job), { once: true });
            this.startNext();
        });
    }

    public async close(): Promise<void> {
        this.closing = true;
        const queued = [...this.foreground, ...this.background];
        this.foreground = [];
        this.background = [];
        for (const job of queued) job.resolve(failed('shutdown'));
        const deadline = Date.now() + this.closeGraceMs;
        while (this.active.size > 0 && Date.now() < deadline) await Bun.sleep(10);
        for (const active of this.active.values()) active.kill('shutdown');
        const killed = Date.now() + KILL_WAIT_MS;
        while (this.active.size > 0 && Date.now() < killed) await Bun.sleep(10);
        for (const active of [...this.active.values()]) active.settle(failed('shutdown'));
    }

    private cancel(job: Job): void {
        const queue = job.priority === 'foreground' ? this.foreground : this.background;
        const index = queue.indexOf(job);
        if (index >= 0) {
            queue.splice(index, 1);
            job.resolve(failed('canceled'));
            return;
        }
        this.active.get(job.id)?.kill('canceled');
    }

    private startNext(): void {
        while (this.active.size < MAX_ACTIVE_CHILDREN && !this.closing) {
            const job = this.foreground.shift() ?? this.background.shift();
            if (!job) return;
            this.runJob(job);
        }
    }

    private runJob(job: Job): void {
        const queueWaitMs = Date.now() - job.enqueuedAt;
        const queueDepth = this.foreground.length + this.background.length;
        let inputBytes = inputBytesOf(job.request);
        let prepMs = job.prepMs;
        const startedAt = Date.now();
        const prep = new AbortController();
        let child: Subprocess | undefined;
        let acked = false;
        let mediaAsked = false;
        let killedBy: RunnerKill | undefined;
        let exited = false;
        let disconnected = false;
        let transformMs: number | undefined;
        let peakRssBytes: number | undefined;

        const settle = (response: DocumentTransformResponse) => {
            if (!this.active.has(job.id)) return;
            this.active.delete(job.id);
            clearTimeout(timer);
            prep.abort();
            child?.kill('SIGKILL');
            job.resolve(response);
            // A reply this line can't read, from a bug in the child, must not stop the queue: the caller fails on it.
            try {
                const totalMs = Date.now() - startedAt;
                const outcome = response.ok ? 'success' : response.error.code;
                const outputBytes = response.ok ? resultBytes(response.result) : 0;
                const warnings = response.ok && response.warnings.length > 0 ? response.warnings : null;
                const signal = exited ? child?.signalCode : null;
                // The child stamps only the transform's own time. The rest is the spawn, the module evaluation and
                // the messaging. totalMs is whole milliseconds and the stamp fractional, so it is clamped at 0.
                const startupMs = transformMs === undefined ? -1 : Math.max(0, Math.round(totalMs - transformMs));
                console.log(
                    `[transform] job=${job.id} kind=${job.request.kind} type=${requestType(job.request)} ` +
                        `format=${requestFormat(job.request)} priority=${job.priority} outcome=${outcome} ` +
                        `queueDepth=${queueDepth} queueWaitMs=${queueWaitMs} ` +
                        `captureMs=${job.captureMs?.toFixed(0) ?? -1} prepMs=${prepMs?.toFixed(0) ?? -1} ` +
                        `inputBytes=${inputBytes} startupMs=${startupMs} ` +
                        `transformMs=${transformMs?.toFixed(0) ?? -1} totalMs=${totalMs} outputBytes=${outputBytes} ` +
                        `peakRssBytes=${peakRssBytes ?? -1}` +
                        (signal ? ` signal=${signal}` : '') +
                        (warnings ? ` warnings=${warnings.map(formatWarning).join(',')}` : ''),
                );
            } catch (err) {
                console.error(`[transform] job=${job.id} reply could not be logged:`, err);
            }
            this.startNext();
        };
        // Bun delivers every message before the channel closes, which can come after the exit, and the ack decides
        // the outcome: so a child's end is read once both happened.
        const ended = () => {
            if (exited && disconnected) settle(failed(childOutcome(child?.signalCode ?? null, killedBy, acked)));
        };
        const kill = (reason: RunnerKill) => {
            killedBy = reason;
            prep.abort();
            child?.kill('SIGKILL');
        };
        // Asked once, after the child read its document: the media prep's bytes are held only while the job holds the
        // slot, and its failure (a 413 past the cap) is the job's.
        const provideMedia = async (names: string[]) => {
            if (!this.active.has(job.id)) return;
            if (mediaAsked || !job.prepareMedia) {
                settle(errorResponse('invalid-response', 'The transform asked for media it was not given'));
                return;
            }
            mediaAsked = true;
            const prepStart = performance.now();
            try {
                const media = await job.prepareMedia(names, prep.signal);
                prepMs = performance.now() - prepStart;
                if (!this.active.has(job.id)) return;
                for (const item of media) inputBytes += item.data.byteLength;
                const reply: ParentMediaReply = { jobId: job.id, media };
                child?.send(reply);
            } catch (err) {
                settle({ ok: false, error: toTransformError(err) });
            }
        };
        this.active.set(job.id, { kill, settle, admissionCostMs: job.admissionCostMs });

        const timer = setTimeout(() => kill('timeout'), job.deadlineMs);
        // Spawning and sending can throw at once, such as a failed spawn or a DataCloneError on a detached buffer.
        // Unhandled, that would hold the only slot until the deadline.
        try {
            child = Bun.spawn(limitedCommand([process.execPath, this.entry], job.deadlineMs, this.memoryLimitKiB), {
                // What the transform graph reads: the data root and mode the eml preview's mail imports resolve
                // at load, and the temp dir. The time zone is the parent's, which bun test sets without TZ.
                env: {
                    PATH: process.env['PATH'],
                    TMPDIR: process.env['TMPDIR'],
                    NODE_ENV: process.env['NODE_ENV'],
                    EIGEN_DATA_ROOT: process.env['EIGEN_DATA_ROOT'],
                    TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    BUN_JSC_jitMemoryReservationSize: JIT_RESERVATION_BYTES,
                },
                stdio: ['ignore', 'inherit', 'inherit'],
                serialization: 'advanced',
                ipc: (message: Partial<ChildAck & ChildMediaRequest & ChildResponseEnvelope> | null) => {
                    if (message?.ack === true) {
                        acked = true;
                        return;
                    }
                    if (message?.mediaNames) {
                        void provideMedia(message.mediaNames);
                        return;
                    }
                    if (!message?.response) {
                        settle(errorResponse('invalid-response', 'The transform sent a message that is no reply'));
                        return;
                    }
                    const { response } = message;
                    // The status becomes the HTTP status the main thread throws, so only an error status may cross.
                    const status = response.ok ? undefined : response.error.status;
                    if (status !== undefined && !(Number.isInteger(status) && status >= 400 && status <= 599)) {
                        settle(errorResponse('invalid-response', 'The transform returned a status that is no error'));
                        return;
                    }
                    transformMs = message.transformMs;
                    peakRssBytes = message.peakRssBytes;
                    settle(response);
                },
                onExit: () => {
                    exited = true;
                    ended();
                },
                onDisconnect: () => {
                    disconnected = true;
                    ended();
                },
            });
            child.send({ jobId: job.id, request: job.request });
        } catch (err) {
            console.error(`[transform] job=${job.id} child start failed:`, err);
            settle(failed('crashed'));
        }
    }
}

export const documentTransformRunner = new DocumentTransformRunner();
