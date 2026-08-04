import { describe, expect, test } from 'bun:test';
import { ApiError } from '../lib/core/errors';
import type { DocumentTransformRequest, DocumentTransformResponse } from '../lib/document/transform/protocol';
import { DocumentTransformRunner, TRANSFORM_LIMITS } from '../lib/document/transform/runner';
import { exportBytes, importSnapshot, previewBody } from './fixtures/transform-results';

// Runner behavior suite (proposal § Runner tests), driven through the scriptable
// test worker so no document code runs. The real preview operation is covered in
// document-transform.test.ts.

const TEST_WORKER_URL = new URL('./fixtures/transform-test-worker.ts', import.meta.url).href;

type TestDirective = { behavior?: string; ms?: number };

function makeRequest(directive: TestDirective = {}, buffers: ArrayBuffer[] = []): DocumentTransformRequest {
    const request = {
        kind: 'preview',
        documentType: 'eigensheets',
        source: { snapshot: null, updates: buffers.map((data, i) => ({ id: i + 1, data })) },
        test: directive,
    };
    return request as unknown as DocumentTransformRequest;
}

function makeExportRequest(directive: TestDirective = {}): DocumentTransformRequest {
    const request = {
        kind: 'export',
        documentType: 'eigensheets',
        format: 'html',
        title: 'runner-test',
        source: { snapshot: null, updates: [] },
        test: directive,
    };
    return request as unknown as DocumentTransformRequest;
}

// Doc/slides exports carry prepared media buffers, which ride the same transfer list.
function makeMediaExportRequest(directive: TestDirective, media: ArrayBuffer[]): DocumentTransformRequest {
    const request = {
        kind: 'export',
        documentType: 'eigendoc',
        format: 'html',
        title: 'runner-test',
        media: media.map((data, i) => ({ name: `media-${i}.png`, contentType: 'image/png', data })),
        source: { snapshot: null, updates: [] },
        test: directive,
    };
    return request as unknown as DocumentTransformRequest;
}

function makeImportRequest(directive: TestDirective = {}, data: ArrayBuffer = new ArrayBuffer(0)) {
    const request = { kind: 'import', sourceFormat: 'xlsx', targetType: 'eigensheets', data, test: directive };
    return request as unknown as DocumentTransformRequest;
}

// The production limits per kind. Tests about lifecycle rather than admission run
// under them unchanged.
const PREVIEW_OPTIONS = { ...TRANSFORM_LIMITS.preview, priority: 'foreground' } as const;
const EXPORT_OPTIONS = { ...TRANSFORM_LIMITS.export, priority: 'foreground' } as const;
const BACKGROUND_OPTIONS = { ...PREVIEW_OPTIONS, priority: 'background' } as const;

function makeRunner(opts: ConstructorParameters<typeof DocumentTransformRunner>[0] = {}) {
    return new DocumentTransformRunner({ workerUrl: TEST_WORKER_URL, ...opts });
}

function timings(response: DocumentTransformResponse): { startedAt: number; endedAt: number } {
    return JSON.parse(previewBody(response));
}

describe('DocumentTransformRunner', () => {
    test('runs at most one worker at a time, FIFO within a priority', async () => {
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
        const first = runner.run(makeRequest({ behavior: 'sleep', ms: 100 }), PREVIEW_OPTIONS);
        await Bun.sleep(10); // let the first job occupy the worker slot
        const background = runner.run(makeRequest(), BACKGROUND_OPTIONS);
        const foreground = runner.run(makeRequest(), PREVIEW_OPTIONS);

        const [, bg, fg] = await Promise.all([first, background, foreground]);
        expect(timings(fg).startedAt).toBeLessThanOrEqual(timings(bg).startedAt);
        await runner.close();
    });

    test('rejects foreground work with 503 when the queue is full', async () => {
        const runner = makeRunner({ maxQueued: 1 });
        const active = runner.run(makeRequest({ behavior: 'sleep', ms: 150 }), PREVIEW_OPTIONS);
        await Bun.sleep(10);
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

    test('rejects foreground work when predicted wait exceeds the bound', async () => {
        const runner = makeRunner({ maxPredictedWaitMs: 250 });
        // Long kill deadlines, small admission costs: the bound is spent on cost alone.
        const options = { priority: 'foreground' as const, deadlineMs: 5000, admissionCostMs: 100 };
        const jobs = [runner.run(makeRequest({ behavior: 'sleep', ms: 30 }), options)];
        await Bun.sleep(10);
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
        await Bun.sleep(10);
        const queued = runner.run(makeRequest(), BACKGROUND_OPTIONS);
        expect(() => runner.run(makeRequest(), BACKGROUND_OPTIONS)).toThrow(ApiError);
        await Promise.all([active, queued]);
        await runner.close();
    });

    test('background work stops at its queue share while foreground still admits', async () => {
        const runner = makeRunner();
        const active = runner.run(makeRequest({ behavior: 'sleep', ms: 150 }), PREVIEW_OPTIONS);
        await Bun.sleep(10); // let the first job occupy the worker slot
        const queued = Array.from({ length: 8 }, () => runner.run(makeRequest(), BACKGROUND_OPTIONS));

        expect(() => runner.run(makeRequest(), BACKGROUND_OPTIONS)).toThrow(ApiError);
        // The eight background rows are far below the 16-job bound, so a preview still runs.
        const foreground = await runner.run(makeRequest(), PREVIEW_OPTIONS);
        expect(foreground.ok).toBe(true);

        await Promise.all([active, ...queued]);
        await runner.close();
    });

    test('timeout terminates the worker, resolves a structured error, and releases the slot', async () => {
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

    test('a crashing worker resolves a structured error and releases the slot', async () => {
        const runner = makeRunner();
        const crashed = await runner.run(makeRequest({ behavior: 'crash' }), PREVIEW_OPTIONS);
        expect(crashed.ok).toBe(false);
        if (!crashed.ok) expect(crashed.error.code).toBe('crashed');

        const next = await runner.run(makeRequest(), PREVIEW_OPTIONS);
        expect(next.ok).toBe(true);
        await runner.close();
    });

    test('a worker that exits without replying resolves a structured error', async () => {
        const runner = makeRunner();
        const exited = await runner.run(makeRequest({ behavior: 'exit' }), PREVIEW_OPTIONS);
        expect(exited.ok).toBe(false);
        if (!exited.ok) expect(exited.error.code).toBe('crashed');
        await runner.close();
    });

    test('a malformed worker response resolves a structured error', async () => {
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

    test('input buffers transfer (detach) to the worker and arrive intact', async () => {
        const runner = makeRunner();
        const buffer = new Uint8Array([1, 2, 3, 4, 5]).buffer;
        const response = await runner.run(makeRequest({ behavior: 'echo-buffers' }, [buffer]), PREVIEW_OPTIONS);
        expect(buffer.byteLength).toBe(0); // detached from the sender
        expect(JSON.parse(previewBody(response)).receivedBytes).toEqual([5]);
        await runner.close();
    });

    test('an export result buffer arrives intact through the response transfer list', async () => {
        const runner = makeRunner();
        const response = await runner.run(makeExportRequest({ behavior: 'export-ok' }), EXPORT_OPTIONS);
        expect([...new Uint8Array(exportBytes(response))]).toEqual([9, 8, 7, 6]);
        await runner.close();
    });

    test('export media buffers transfer (detach) to the worker and arrive intact', async () => {
        const runner = makeRunner();
        const media = [new Uint8Array([1, 2, 3]).buffer, new Uint8Array([4, 5, 6, 7]).buffer];
        const response = await runner.run(
            makeMediaExportRequest({ behavior: 'export-echo-media' }, media),
            EXPORT_OPTIONS,
        );
        expect(media.map((buffer) => buffer.byteLength)).toEqual([0, 0]); // detached from the sender
        expect(JSON.parse(Buffer.from(exportBytes(response)).toString('utf-8'))).toEqual([3, 4]);
        await runner.close();
    });

    test('an export response without export bytes resolves as invalid-response', async () => {
        const runner = makeRunner();
        const malformed = await runner.run(makeExportRequest({ behavior: 'export-malformed' }), EXPORT_OPTIONS);
        expect(malformed.ok).toBe(false);
        if (!malformed.ok) expect(malformed.error.code).toBe('invalid-response');
        await runner.close();
    });

    test('import bytes transfer to the worker and the snapshot returns intact', async () => {
        const runner = makeRunner();
        const data = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer;
        const response = await runner.run(makeImportRequest({ behavior: 'import-ok' }, data), EXPORT_OPTIONS);
        expect(data.byteLength).toBe(0); // detached from the sender
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

    test('aborting a queued job removes it before any worker runs it', async () => {
        const runner = makeRunner();
        const active = runner.run(makeRequest({ behavior: 'sleep', ms: 150 }), PREVIEW_OPTIONS);
        await Bun.sleep(10);
        const controller = new AbortController();
        const queued = runner.run(makeRequest(), { ...PREVIEW_OPTIONS, signal: controller.signal });
        controller.abort();
        const canceled = await queued;
        expect(canceled.ok).toBe(false);
        if (!canceled.ok) expect(canceled.error.code).toBe('canceled');
        await active;
        await runner.close();
    });

    test('aborting an active job terminates its worker and releases the slot', async () => {
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

    test('close() rejects queued work, stops admission, and terminates active workers after grace', async () => {
        const runner = makeRunner({ closeGraceMs: 50 });
        const active = runner.run(makeRequest({ behavior: 'sleep', ms: 2000 }), PREVIEW_OPTIONS);
        await Bun.sleep(10);
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
