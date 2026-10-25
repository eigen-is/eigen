import { describe, expect, spyOn, test } from 'bun:test';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../../lib/core/errors';
import type {
    DocumentTransformRequest,
    DocumentTransformResponse,
    ExportMedia,
} from '../../lib/document/transform/protocol';
import { toTransferableBuffer } from '../../lib/document/transform/protocol';
import { DocumentTransformRunner, TRANSFORM_LIMITS } from '../../lib/document/transform/runner';
import { exportBytes, importSnapshot, previewBody } from '../fixtures/transform-results';

// Runner behavior suite, driven through the scriptable test child so no document
// code runs. The real preview operation is covered in document-transform.test.ts.

const TEST_CHILD = fileURLToPath(new URL('../fixtures/transform-test-child.ts', import.meta.url));

type TestDirective = {
    behavior?: string;
    ms?: number;
    beforeAck?: boolean;
    signal?: NodeJS.Signals;
    heap?: 'objects' | 'strings' | 'buffers';
    mediaNames?: unknown[];
};

// The scriptable child reads its script off `test`, the one field a production request
// never carries. Fixtures are the production type plus that directive, so a new required
// field on a request arm breaks them at compile time instead of at run time.
type TestRequest = DocumentTransformRequest & { test: TestDirective };

function makeRequest(directive: TestDirective = {}, buffers: ArrayBuffer[] = []): TestRequest {
    return {
        kind: 'preview',
        documentType: 'eigensheets',
        mediaUrls: new Map(),
        source: { snapshot: null, updates: buffers.map((data, i) => ({ id: i + 1, data })) },
        test: directive,
    };
}

function makeExportRequest(directive: TestDirective = {}): TestRequest {
    return {
        kind: 'export',
        documentType: 'eigensheets',
        format: 'html',
        title: 'runner-test',
        source: { snapshot: null, updates: [] },
        test: directive,
    };
}

// The media a test's prepareMedia hands back, one PNG per buffer.
function pngMedia(buffers: ArrayBuffer[]): ExportMedia[] {
    return buffers.map((data, i) => ({ name: `media-${i}.png`, contentType: 'image/png', data }));
}

function makeImportRequest(directive: TestDirective = {}, data: ArrayBuffer = new ArrayBuffer(0)): TestRequest {
    return { kind: 'import', sourceFormat: 'xlsx', targetType: 'eigensheets', maxMediaBytes: 0, data, test: directive };
}

// The only result arm with a nested payload of its own: the extracted docx images.
function makeDocImportRequest(directive: TestDirective = {}): TestRequest {
    return {
        kind: 'import',
        sourceFormat: 'docx',
        targetType: 'eigendoc',
        publicOrigin: undefined,
        maxMediaBytes: 0,
        data: new ArrayBuffer(0),
        test: directive,
    };
}

// The production limits per kind. Tests about lifecycle rather than admission run
// under them unchanged.
const PREVIEW_OPTIONS = { ...TRANSFORM_LIMITS.preview, priority: 'foreground' } as const;
const EXPORT_OPTIONS = { ...TRANSFORM_LIMITS.export, priority: 'foreground' } as const;
const BACKGROUND_OPTIONS = { ...PREVIEW_OPTIONS, priority: 'background' } as const;

// The admission bounds and the memory limit are private production constants — no caller
// configures them, so a test dials them in place instead.
type RunnerBounds = {
    maxQueued: number;
    maxQueuedBackground: number;
    maxPredictedWaitMs: number;
    closeGraceMs: number;
    memoryLimitKiB: number;
};

function makeRunner(bounds: Partial<RunnerBounds> = {}) {
    const runner = new DocumentTransformRunner({ entry: TEST_CHILD });
    Object.assign(runner as unknown as RunnerBounds, bounds);
    return runner;
}

function timings(response: DocumentTransformResponse): { startedAt: number; endedAt: number } {
    return JSON.parse(previewBody(response));
}

function errorCode(response: DocumentTransformResponse): string | undefined {
    return response.ok ? undefined : response.error.code;
}

describe('DocumentTransformRunner', () => {
    test('runs at most one child at a time, FIFO within a priority', async () => {
        const runner = makeRunner();
        const results = await Promise.all([
            runner.run(makeRequest({ behavior: 'sleep', ms: 80 }), PREVIEW_OPTIONS),
            runner.run(makeRequest({ behavior: 'sleep', ms: 80 }), PREVIEW_OPTIONS),
            runner.run(makeRequest({ behavior: 'sleep', ms: 80 }), PREVIEW_OPTIONS),
        ]);
        const spans = results.map(timings);
        // FIFO: submission order is execution order.
        expect(spans[0].startedAt).toBeLessThanOrEqual(spans[1].startedAt);
        expect(spans[1].startedAt).toBeLessThanOrEqual(spans[2].startedAt);
        // Concurrency 1: execution windows never overlap.
        expect(spans[1].startedAt).toBeGreaterThanOrEqual(spans[0].endedAt);
        expect(spans[2].startedAt).toBeGreaterThanOrEqual(spans[1].endedAt);
        await runner.close();
    });

    test('waiting foreground work runs before queued background work', async () => {
        const runner = makeRunner();
        // run() starts the first job synchronously; a wait here could outlast it on a loaded runner.
        const first = runner.run(makeRequest({ behavior: 'sleep', ms: 100 }), PREVIEW_OPTIONS);
        const background = runner.run(makeRequest(), BACKGROUND_OPTIONS);
        const foreground = runner.run(makeRequest(), PREVIEW_OPTIONS);

        const [, bg, fg] = await Promise.all([first, background, foreground]);
        expect(timings(fg).startedAt).toBeLessThanOrEqual(timings(bg).startedAt);
        await runner.close();
    });

    test('rejects foreground work with 503 when the queue is full', async () => {
        const runner = makeRunner({ maxQueued: 1 });
        const active = runner.run(makeRequest({ behavior: 'sleep', ms: 150 }), PREVIEW_OPTIONS);
        const queued = runner.run(makeRequest(), PREVIEW_OPTIONS);

        expect(() => runner.run(makeRequest(), PREVIEW_OPTIONS)).toThrow(ApiError);
        try {
            runner.run(makeRequest(), PREVIEW_OPTIONS);
        } catch (err) {
            expect((err as ApiError).status).toBe(503);
            expect((err as ApiError).message).toContain('busy');
        }
        await Promise.all([active, queued]);
        await runner.close();
    });

    // DOCUMENT-TRANSFORMS.md § The runner logs one line per job, overload included: an overload
    // has to leave a trace, and a job's record needs its format and startup time (total minus the child's
    // own transform time) to tell a slow document from a slow spawn.
    test('logs every refused admission with the queue state', async () => {
        const runner = makeRunner({ maxQueued: 1 });
        const active = runner.run(makeRequest({ behavior: 'sleep', ms: 100 }), PREVIEW_OPTIONS);
        const queued = runner.run(makeRequest(), PREVIEW_OPTIONS);

        const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
        expect(() => runner.run(makeRequest(), PREVIEW_OPTIONS)).toThrow(ApiError);
        const warned = warnSpy.mock.calls.map((args) => String(args[0]));
        warnSpy.mockRestore();

        expect(warned).toHaveLength(1);
        expect(warned[0]).toContain('priority=foreground');
        expect(warned[0]).toContain('queueDepth=1');

        await Promise.all([active, queued]);
        await runner.close();
    });

    test("logs the format, startup time, the child's peak and warning payloads with the job", async () => {
        const runner = makeRunner();
        const logSpy = spyOn(console, 'log').mockImplementation(() => {});
        const response = await runner.run(makeExportRequest({ behavior: 'export-warn' }), EXPORT_OPTIONS);
        const logged = logSpy.mock.calls.map((args) => String(args[0]));
        logSpy.mockRestore();

        expect(response.ok).toBe(true);
        // The process-wide runner logs other files' jobs inside this window too; this job's warning marks its line.
        const line =
            logged.find((l) => l.includes('kind=export') && l.includes('warnings=corrupt-blobs-skipped:3')) ?? '';
        expect(line).toContain('format=html');
        expect(line).toMatch(/startupMs=\d+/);
        expect(line).toContain('peakRssBytes=1234');
        await runner.close();
    });

    test('rejects foreground work when predicted wait exceeds the bound', async () => {
        const runner = makeRunner({ maxPredictedWaitMs: 250 });
        // Long kill deadlines, small admission costs: the bound is spent on cost alone.
        const options = { priority: 'foreground' as const, deadlineMs: 5000, admissionCostMs: 100 };
        const jobs = [runner.run(makeRequest({ behavior: 'sleep', ms: 30 }), options)];
        // active (100ms) + one queued (100ms) = 200 ≤ 250 → admitted…
        jobs.push(runner.run(makeRequest(), options));
        jobs.push(runner.run(makeRequest(), options));
        // …but active + two queued = 300 > 250 → rejected.
        expect(() => runner.run(makeRequest(), options)).toThrow(ApiError);
        await Promise.all(jobs);
        await runner.close();
    });

    test('prices foreground admission by admission cost, not by the kill deadline', async () => {
        const runner = makeRunner(); // production bound: 120_000ms
        // Admission is synchronous, so nothing drains between these calls.
        const jobs = Array.from({ length: 5 }, () =>
            runner.run(makeExportRequest({ behavior: 'export-ok' }), EXPORT_OPTIONS),
        );
        // The fifth predicted 4 × 30_000 = 120_000 ≤ the bound, where summed 120_000
        // deadlines already 503'd the third. The sixth predicts 150_000 > 120_000.
        expect(() => runner.run(makeExportRequest({ behavior: 'export-ok' }), EXPORT_OPTIONS)).toThrow(ApiError);
        const results = await Promise.all(jobs);
        expect(results.every((result) => result.ok)).toBe(true);
        await runner.close();
    });

    test('a preview admits while an export runs with another queued', async () => {
        const runner = makeRunner();
        const exports = [
            runner.run(makeExportRequest({ behavior: 'export-ok' }), EXPORT_OPTIONS),
            runner.run(makeExportRequest({ behavior: 'export-ok' }), EXPORT_OPTIONS),
        ];
        // Two exports predict 60_000 of wait on their cost, 240_000 on their deadlines.
        const preview = await runner.run(makeRequest(), PREVIEW_OPTIONS);
        expect(preview.ok).toBe(true);
        await Promise.all(exports);
        await runner.close();
    });

    test('drops queued background work on overflow without running it', async () => {
        const runner = makeRunner({ maxQueued: 1 });
        const active = runner.run(makeRequest({ behavior: 'sleep', ms: 150 }), PREVIEW_OPTIONS);
        const queued = runner.run(makeRequest(), BACKGROUND_OPTIONS);
        expect(() => runner.run(makeRequest(), BACKGROUND_OPTIONS)).toThrow(ApiError);
        await Promise.all([active, queued]);
        await runner.close();
    });

    test('background work stops at its queue share while foreground still admits', async () => {
        const runner = makeRunner({ maxQueuedBackground: 1 });
        const active = runner.run(makeRequest({ behavior: 'sleep', ms: 150 }), PREVIEW_OPTIONS);
        const queued = runner.run(makeRequest(), BACKGROUND_OPTIONS);

        expect(() => runner.run(makeRequest(), BACKGROUND_OPTIONS)).toThrow(ApiError);
        // The background share is exhausted but the queue is not — a preview still runs.
        const foreground = await runner.run(makeRequest(), PREVIEW_OPTIONS);
        expect(foreground.ok).toBe(true);

        await Promise.all([active, queued]);
        await runner.close();
    });

    test('timeout kills the child, resolves a structured error, and releases the slot', async () => {
        const runner = makeRunner();
        const start = Date.now();
        const timedOut = await runner.run(makeRequest({ behavior: 'sleep', ms: 2000 }), {
            ...PREVIEW_OPTIONS,
            deadlineMs: 100,
        });
        expect(Date.now() - start).toBeLessThan(1500);
        expect(timedOut.ok).toBe(false);
        if (!timedOut.ok) expect(timedOut.error.code).toBe('timeout');

        // The slot is free again: a follow-up job completes normally.
        const next = await runner.run(makeRequest(), PREVIEW_OPTIONS);
        expect(next.ok).toBe(true);
        await runner.close();
    });

    // A caller's prep spends from the deadline (run-transform.ts), and a spent one leaves no time for a child.
    test.each([0, -50])('a deadline of %d ms times out without spawning a child', async (deadlineMs) => {
        const runner = makeRunner();
        const spawn = spyOn(Bun, 'spawn');
        const response = await runner.run(makeExportRequest({ behavior: 'export-ok' }), {
            ...EXPORT_OPTIONS,
            deadlineMs,
        });
        expect(spawn).not.toHaveBeenCalled();
        spawn.mockRestore();
        expect(response).toEqual({ ok: false, error: { code: 'timeout', message: 'Document transform timed out' } });

        const next = await runner.run(makeRequest(), PREVIEW_OPTIONS);
        expect(next.ok).toBe(true);
        await runner.close();
    });

    test('a crashing child resolves a structured error and releases the slot', async () => {
        const runner = makeRunner();
        const crashed = await runner.run(makeRequest({ behavior: 'crash' }), PREVIEW_OPTIONS);
        expect(crashed.ok).toBe(false);
        if (!crashed.ok) expect(crashed.error.code).toBe('crashed');

        const next = await runner.run(makeRequest(), PREVIEW_OPTIONS);
        expect(next.ok).toBe(true);
        await runner.close();
    });

    test('a job that cannot be sent resolves a structured error and releases the slot', async () => {
        const runner = makeRunner();
        // A detached buffer makes the send throw synchronously, the same shape as a
        // spawn failure under resource exhaustion.
        const detached = new Uint8Array([1, 2, 3]).buffer;
        structuredClone(detached, { transfer: [detached] });

        const start = Date.now();
        const failed = await runner.run(makeRequest({}, [detached]), PREVIEW_OPTIONS);
        expect(Date.now() - start).toBeLessThan(1000); // not held until the kill deadline
        expect(failed.ok).toBe(false);
        if (!failed.ok) expect(failed.error.code).toBe('crashed');

        const next = await runner.run(makeRequest(), PREVIEW_OPTIONS);
        expect(next.ok).toBe(true);
        await runner.close();
    });

    test('a child that exits without replying resolves a structured error', async () => {
        const runner = makeRunner();
        const exited = await runner.run(makeRequest({ behavior: 'exit' }), PREVIEW_OPTIONS);
        expect(errorCode(exited)).toBe('crashed');
        await runner.close();
    });

    test('a child that cannot load its entry crashed, it did not run out of memory', async () => {
        const runner = new DocumentTransformRunner({ entry: `${TEST_CHILD}.missing` });
        const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
        const failed = await runner.run(makeRequest(), PREVIEW_OPTIONS);
        errorSpy.mockRestore();
        expect(errorCode(failed)).toBe('crashed');
        await runner.close();
    });

    // A death after the child took the job is the job's: JSC aborts, faults or traps when a heap allocation fails, and
    // a SIGKILL the runner did not send is the kernel's OOM killer. SIGBUS is in the Linux-only block: macOS reports it as SIGUSR1.
    test.each(['SIGABRT', 'SIGSEGV', 'SIGTRAP', 'SIGKILL'] as const)(
        'a child killed by %s after taking the job ran out of memory, and the slot is released',
        async (signal) => {
            const runner = makeRunner();
            const logSpy = spyOn(console, 'log').mockImplementation(() => {});
            const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
            const died = await runner.run(makeRequest({ behavior: 'signal', signal }), PREVIEW_OPTIONS);
            const logged = logSpy.mock.calls.map((args) => String(args[0]));
            logSpy.mockRestore();
            errorSpy.mockRestore();
            expect(errorCode(died)).toBe('out-of-memory');
            expect(
                logged.some((line) => line.includes('outcome=out-of-memory') && line.includes(`signal=${signal}`)),
            ).toBe(true);

            const next = await runner.run(makeRequest(), PREVIEW_OPTIONS);
            expect(next.ok).toBe(true);
            await runner.close();
        },
    );

    // Before the acknowledgement the death is the child's own start-up; SIGINT and SIGTERM come from a person or a
    // process manager, never from memory.
    test.each([
        ['SIGABRT before taking the job', { behavior: 'signal', signal: 'SIGABRT', beforeAck: true }],
        ['SIGINT', { behavior: 'signal', signal: 'SIGINT' }],
        ['SIGTERM', { behavior: 'signal', signal: 'SIGTERM' }],
    ] as const)('a child killed by %s crashed', async (_name, directive) => {
        const runner = makeRunner();
        const died = await runner.run(makeRequest(directive), PREVIEW_OPTIONS);
        expect(errorCode(died)).toBe('crashed');
        await runner.close();
    });

    test('an out-of-memory the child caught comes back as out-of-memory', async () => {
        const runner = makeRunner();
        const caught = await runner.run(makeRequest({ behavior: 'oom-reply' }), PREVIEW_OPTIONS);
        expect(caught).toEqual({ ok: false, error: { code: 'out-of-memory', message: 'Out of memory' } });
        await runner.close();
    });

    test('a malformed child response resolves a structured error', async () => {
        const runner = makeRunner();
        const malformed = await runner.run(makeRequest({ behavior: 'malformed' }), PREVIEW_OPTIONS);
        expect(malformed.ok).toBe(false);
        if (!malformed.ok) expect(malformed.error.code).toBe('invalid-response');
        await runner.close();
    });

    test('a half-valid response ({ok:true} without result) resolves instead of hanging', async () => {
        const runner = makeRunner();
        const halfValid = await runner.run(makeRequest({ behavior: 'malformed-ok' }), PREVIEW_OPTIONS);
        expect(halfValid.ok).toBe(false);
        if (!halfValid.ok) expect(halfValid.error.code).toBe('invalid-response');
        await runner.close();
    });

    // Nested junk inside a valid envelope: settle() reads warning codes and image byte
    // lengths after the job left `active`, so a throw there would strand the requester
    // and leave the queue unstarted. The follow-up job proves the queue still drains.
    test('a response with malformed warnings resolves instead of hanging', async () => {
        const runner = makeRunner();
        const malformed = runner.run(makeRequest({ behavior: 'malformed-warnings' }), PREVIEW_OPTIONS);
        const queued = runner.run(makeRequest(), PREVIEW_OPTIONS);

        const [first, second] = await Promise.all([malformed, queued]);
        expect(first.ok).toBe(false);
        if (!first.ok) expect(first.error.code).toBe('invalid-response');
        expect(second.ok).toBe(true);
        await runner.close();
    });

    test('a docx import response with malformed images resolves instead of hanging', async () => {
        const runner = makeRunner();
        const malformed = runner.run(makeDocImportRequest({ behavior: 'import-doc-malformed-images' }), EXPORT_OPTIONS);
        const queued = runner.run(makeRequest(), PREVIEW_OPTIONS);

        const [first, second] = await Promise.all([malformed, queued]);
        expect(first.ok).toBe(false);
        if (!first.ok) expect(first.error.code).toBe('invalid-response');
        expect(second.ok).toBe(true);
        await runner.close();
    });

    test('a structured document error passes through untouched', async () => {
        const runner = makeRunner();
        const failed = await runner.run(makeRequest({ behavior: 'document-error' }), PREVIEW_OPTIONS);
        expect(failed.ok).toBe(false);
        if (!failed.ok) {
            expect(failed.error.code).toBe('transform-failed');
            expect(failed.error.status).toBe(422);
        }
        await runner.close();
    });

    test('a document error with a non-HTTP status is a malformed response', async () => {
        const runner = makeRunner();
        const failed = await runner.run(makeRequest({ behavior: 'document-error-bad-status' }), PREVIEW_OPTIONS);
        expect(failed.ok).toBe(false);
        if (!failed.ok) expect(failed.error.code).toBe('invalid-response');
        await runner.close();
    });

    test('input buffers are copied to the child and arrive intact', async () => {
        const runner = makeRunner();
        const buffer = new Uint8Array([1, 2, 3, 4, 5]).buffer;
        const response = await runner.run(makeRequest({ behavior: 'echo-buffers' }, [buffer]), PREVIEW_OPTIONS);
        expect(buffer.byteLength).toBe(5); // the sender keeps its own
        expect(JSON.parse(previewBody(response)).receivedBytes).toEqual([5]);
        await runner.close();
    });

    // IPC serializes a view's whole backing buffer, so only a view is copied out; an exact buffer goes as it is.
    test('toTransferableBuffer copies a view and passes an exact buffer', () => {
        const whole = new Uint8Array([1, 2, 3]);
        expect(toTransferableBuffer(whole)).toBe(whole.buffer);
        const view = new Uint8Array(new ArrayBuffer(1024), 8, 3);
        view.set([4, 5, 6]);
        const copied = toTransferableBuffer(view);
        expect(copied.byteLength).toBe(3);
        expect([...new Uint8Array(copied)]).toEqual([4, 5, 6]);
    });

    test('an export result buffer arrives intact', async () => {
        const runner = makeRunner();
        const response = await runner.run(makeExportRequest({ behavior: 'export-ok' }), EXPORT_OPTIONS);
        expect([...new Uint8Array(exportBytes(response))]).toEqual([9, 8, 7, 6]);
        await runner.close();
    });

    test('the media an export child names are prepared and copied to it, and arrive intact', async () => {
        const runner = makeRunner();
        const buffers = [new Uint8Array([1, 2, 3]).buffer, new Uint8Array([4, 5, 6, 7]).buffer];
        const asked: string[][] = [];
        const response = await runner.run(
            makeExportRequest({ behavior: 'export-echo-media', mediaNames: ['media-0.png', 'media-1.png'] }),
            {
                ...EXPORT_OPTIONS,
                prepareMedia: async (names) => {
                    asked.push(names);
                    return pngMedia(buffers);
                },
            },
        );
        expect(asked).toEqual([['media-0.png', 'media-1.png']]);
        expect(buffers.map((buffer) => buffer.byteLength)).toEqual([3, 4]); // the sender keeps its own
        expect(JSON.parse(Buffer.from(exportBytes(response)).toString('utf-8'))).toEqual([
            ['media-0.png', 3],
            ['media-1.png', 4],
        ]);
        await runner.close();
    });

    // A 413 past the media cap keeps its status, as a document error does.
    test("a media prep that refuses fails the job with the prep's status and releases the slot", async () => {
        const runner = makeRunner();
        const response = await runner.run(makeExportRequest({ behavior: 'export-echo-media', mediaNames: ['a'] }), {
            ...EXPORT_OPTIONS,
            prepareMedia: async () => {
                throw new ApiError(413, 'too large');
            },
        });
        expect(response).toEqual({
            ok: false,
            error: { code: 'transform-failed', status: 413, message: 'too large' },
        });
        expect((await runner.run(makeRequest(), PREVIEW_OPTIONS)).ok).toBe(true);
        await runner.close();
    });

    test.each([
        ['a job that offers none', undefined, ['a']],
        ['names that are not strings', async () => [], [1]],
    ])('a child that asks for media on %s is an invalid response', async (_, prepareMedia, mediaNames) => {
        const runner = makeRunner();
        const response = await runner.run(makeExportRequest({ behavior: 'export-echo-media', mediaNames }), {
            ...EXPORT_OPTIONS,
            prepareMedia,
        });
        expect(errorCode(response)).toBe('invalid-response');
        await runner.close();
    });

    // The media is the document's, asked for once: a second ask is a child that is not following the protocol.
    test('a child that asks for media a second time is an invalid response, and the prep ran once', async () => {
        const runner = makeRunner();
        let preps = 0;
        const response = await runner.run(makeExportRequest({ behavior: 'export-ask-twice', mediaNames: ['a'] }), {
            ...EXPORT_OPTIONS,
            prepareMedia: async () => {
                preps++;
                return [];
            },
        });
        expect(errorCode(response)).toBe('invalid-response');
        expect(preps).toBe(1);
        await runner.close();
    });

    // The prep runs inside the job, so the request's abort and the deadline both end it.
    test.each(['canceled', 'timeout'] as const)(
        'a job %s during its media prep kills the child and aborts the prep',
        async (outcome) => {
            const runner = makeRunner();
            const controller = new AbortController();
            let prepSignal: AbortSignal | undefined;
            const start = Date.now();
            const pending = runner.run(makeExportRequest({ behavior: 'export-echo-media', mediaNames: ['a'] }), {
                ...EXPORT_OPTIONS,
                ...(outcome === 'timeout' && { deadlineMs: 1_000 }),
                signal: controller.signal,
                prepareMedia: (_, signal) => {
                    prepSignal = signal;
                    if (outcome === 'canceled') controller.abort();
                    return new Promise(() => {});
                },
            });
            const response = await pending;
            expect(Date.now() - start).toBeLessThan(5_000);
            expect(errorCode(response)).toBe(outcome);
            expect(prepSignal?.aborted).toBe(true);
            expect((await runner.run(makeRequest(), PREVIEW_OPTIONS)).ok).toBe(true);
            await runner.close();
        },
    );

    test('an export response without export bytes resolves as invalid-response', async () => {
        const runner = makeRunner();
        const malformed = await runner.run(makeExportRequest({ behavior: 'export-malformed' }), EXPORT_OPTIONS);
        expect(malformed.ok).toBe(false);
        if (!malformed.ok) expect(malformed.error.code).toBe('invalid-response');
        await runner.close();
    });

    test('import bytes are copied to the child and the snapshot returns intact', async () => {
        const runner = makeRunner();
        const data = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer;
        const response = await runner.run(makeImportRequest({ behavior: 'import-ok' }, data), EXPORT_OPTIONS);
        expect(data.byteLength).toBe(6); // the sender keeps its own
        expect(JSON.parse(importSnapshot(response)).received).toBe(6);
        await runner.close();
    });

    test('an import response without snapshot bytes resolves as invalid-response', async () => {
        const runner = makeRunner();
        const malformed = await runner.run(makeImportRequest({ behavior: 'import-malformed' }), EXPORT_OPTIONS);
        expect(malformed.ok).toBe(false);
        if (!malformed.ok) expect(malformed.error.code).toBe('invalid-response');
        await runner.close();
    });

    test('aborting a queued job removes it before any child runs it', async () => {
        const runner = makeRunner();
        const active = runner.run(makeRequest({ behavior: 'sleep', ms: 150 }), PREVIEW_OPTIONS);
        const controller = new AbortController();
        const queued = runner.run(makeRequest(), { ...PREVIEW_OPTIONS, signal: controller.signal });
        controller.abort();
        const canceled = await queued;
        expect(canceled.ok).toBe(false);
        if (!canceled.ok) expect(canceled.error.code).toBe('canceled');
        await active;
        await runner.close();
    });

    test('aborting an active job kills its child and releases the slot', async () => {
        const runner = makeRunner();
        const controller = new AbortController();
        const start = Date.now();
        const activePromise = runner.run(makeRequest({ behavior: 'sleep', ms: 2000 }), {
            ...PREVIEW_OPTIONS,
            signal: controller.signal,
        });
        await Bun.sleep(20);
        controller.abort();
        const canceled = await activePromise;
        expect(Date.now() - start).toBeLessThan(1000);
        expect(canceled.ok).toBe(false);
        if (!canceled.ok) expect(canceled.error.code).toBe('canceled');

        const next = await runner.run(makeRequest(), PREVIEW_OPTIONS);
        expect(next.ok).toBe(true);
        await runner.close();
    });

    test('close() rejects queued work, stops admission, and kills active children after grace', async () => {
        const runner = makeRunner({ closeGraceMs: 50 });
        const active = runner.run(makeRequest({ behavior: 'sleep', ms: 2000 }), PREVIEW_OPTIONS);
        const queued = runner.run(makeRequest(), PREVIEW_OPTIONS);

        await runner.close();
        const [activeResult, queuedResult] = await Promise.all([active, queued]);
        expect(activeResult.ok).toBe(false);
        if (!activeResult.ok) expect(activeResult.error.code).toBe('shutdown');
        expect(queuedResult.ok).toBe(false);
        if (!queuedResult.ok) expect(queuedResult.error.code).toBe('shutdown');

        expect(() => runner.run(makeRequest(), PREVIEW_OPTIONS)).toThrow(ApiError);
    });
});

// The limit is Linux's alone: macOS refuses setrlimit for the data segment. Each heap fails its own way, by arch too
// (strings fault on arm64 and trap on x86-64), and every way is the job's out-of-memory while the parent serves the next
// job. Below about 768 MiB Bun can't start on x86-64.
describe.skipIf(process.platform !== 'linux')('DocumentTransformRunner memory limit', () => {
    test.each(['objects', 'strings', 'buffers'] as const)(
        'a child allocating %s past its limit ran out of memory, and the parent lives on',
        async (heap) => {
            const runner = makeRunner({ memoryLimitKiB: 1024 * 1024 });
            const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
            const response = await runner.run(makeRequest({ behavior: 'allocate', heap }), PREVIEW_OPTIONS);
            errorSpy.mockRestore();
            expect(errorCode(response)).toBe('out-of-memory');

            const next = await runner.run(makeRequest(), PREVIEW_OPTIONS);
            expect(next.ok).toBe(true);
            await runner.close();
        },
        30_000,
    );

    test('a child killed by SIGBUS after taking the job ran out of memory', async () => {
        const runner = makeRunner();
        const died = await runner.run(makeRequest({ behavior: 'signal', signal: 'SIGBUS' }), PREVIEW_OPTIONS);
        expect(errorCode(died)).toBe('out-of-memory');
        await runner.close();
    });

    // A soft CPU limit ends a spinning orphan with SIGXCPU, a crash; a hard one would SIGKILL it, which reads as out of
    // memory. GC and JIT threads spend CPU on every core, so the limit counts them all.
    test('the child runs under the wrapper: its data limit, a soft CPU limit, no core, the OOM killer first, the JIT knob', async () => {
        const runner = makeRunner({ memoryLimitKiB: 1024 * 1024 });
        const response = await runner.run(makeRequest({ behavior: 'limits' }), PREVIEW_OPTIONS);
        const { oomScoreAdj, limits, jit } = JSON.parse(previewBody(response));
        const limit = (name: string) =>
            String(limits)
                .match(new RegExp(`^${name}\\s+(\\S+)\\s+(\\S+)`, 'm'))
                ?.slice(1);
        const cpuSeconds = Math.ceil(PREVIEW_OPTIONS.deadlineMs / 1000) * availableParallelism() + 60;
        expect(oomScoreAdj).toBe('1000');
        expect(limit('Max data size')).toEqual([String(1024 ** 3), String(1024 ** 3)]);
        expect(limit('Max cpu time')).toEqual([String(cpuSeconds), 'unlimited']);
        expect(limit('Max core file size')?.[0]).toBe('0');
        expect(jit).toBe('67108864');
        await runner.close();
    });
});
