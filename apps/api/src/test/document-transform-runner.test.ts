import { describe, expect, test } from 'bun:test';
import { ApiError } from '../lib/core/errors';
import type { DocumentTransformRequest, DocumentTransformResponse } from '../lib/document/transform/protocol';
import { DocumentTransformRunner } from '../lib/document/transform/runner';

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

function makeRunner(opts: ConstructorParameters<typeof DocumentTransformRunner>[0] = {}) {
    return new DocumentTransformRunner({ workerUrl: TEST_WORKER_URL, ...opts });
}

function responseBody(response: DocumentTransformResponse): string {
    if (!response.ok || !('body' in response.result)) {
        throw new Error(`expected a body response, got ${JSON.stringify(response)}`);
    }
    return response.result.body;
}

function timings(response: DocumentTransformResponse): { startedAt: number; endedAt: number } {
    return JSON.parse(responseBody(response));
}

function exportBytes(response: DocumentTransformResponse): ArrayBuffer {
    if (!response.ok || !('data' in response.result)) {
        throw new Error(`expected export bytes, got ${JSON.stringify(response)}`);
    }
    return response.result.data;
}

function importSnapshot(response: DocumentTransformResponse): string {
    if (!response.ok || !('snapshotJson' in response.result)) {
        throw new Error(`expected an import snapshot, got ${JSON.stringify(response)}`);
    }
    return new TextDecoder().decode(response.result.snapshotJson);
}

describe('DocumentTransformRunner', () => {
    test('runs at most one worker at a time, FIFO within a priority', async () => {
        const runner = makeRunner();
        const results = await Promise.all([
            runner.run(makeRequest({ behavior: 'sleep', ms: 80 }), { priority: 'foreground', deadlineMs: 5000 }),
            runner.run(makeRequest({ behavior: 'sleep', ms: 80 }), { priority: 'foreground', deadlineMs: 5000 }),
            runner.run(makeRequest({ behavior: 'sleep', ms: 80 }), { priority: 'foreground', deadlineMs: 5000 }),
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
        const first = runner.run(makeRequest({ behavior: 'sleep', ms: 100 }), {
            priority: 'foreground',
            deadlineMs: 5000,
        });
        await Bun.sleep(10); // let the first job occupy the worker slot
        const background = runner.run(makeRequest(), { priority: 'background', deadlineMs: 5000 });
        const foreground = runner.run(makeRequest(), { priority: 'foreground', deadlineMs: 5000 });

        const [, bg, fg] = await Promise.all([first, background, foreground]);
        expect(timings(fg).startedAt).toBeLessThanOrEqual(timings(bg).startedAt);
        await runner.close();
    });

    test('rejects foreground work with 503 when the queue is full', async () => {
        const runner = makeRunner({ maxQueued: 1 });
        const active = runner.run(makeRequest({ behavior: 'sleep', ms: 150 }), {
            priority: 'foreground',
            deadlineMs: 5000,
        });
        await Bun.sleep(10);
        const queued = runner.run(makeRequest(), { priority: 'foreground', deadlineMs: 5000 });

        expect(() => runner.run(makeRequest(), { priority: 'foreground', deadlineMs: 5000 })).toThrow(ApiError);
        try {
            runner.run(makeRequest(), { priority: 'foreground', deadlineMs: 5000 });
        } catch (err) {
            expect((err as ApiError).status).toBe(503);
            expect((err as ApiError).message).toContain('busy');
        }
        await Promise.all([active, queued]);
        await runner.close();
    });

    test('rejects foreground work when predicted wait exceeds the bound', async () => {
        const runner = makeRunner({ maxPredictedWaitMs: 250 });
        const jobs = [
            runner.run(makeRequest({ behavior: 'sleep', ms: 30 }), { priority: 'foreground', deadlineMs: 100 }),
        ];
        await Bun.sleep(10);
        // active (100ms) + one queued (100ms) = 200 ≤ 250 → admitted…
        jobs.push(runner.run(makeRequest(), { priority: 'foreground', deadlineMs: 100 }));
        jobs.push(runner.run(makeRequest(), { priority: 'foreground', deadlineMs: 100 }));
        // …but active + two queued = 300 > 250 → rejected.
        expect(() => runner.run(makeRequest(), { priority: 'foreground', deadlineMs: 100 })).toThrow(ApiError);
        await Promise.all(jobs);
        await runner.close();
    });

    test('drops queued background work on overflow without running it', async () => {
        const runner = makeRunner({ maxQueued: 1 });
        const active = runner.run(makeRequest({ behavior: 'sleep', ms: 150 }), {
            priority: 'foreground',
            deadlineMs: 5000,
        });
        await Bun.sleep(10);
        const queued = runner.run(makeRequest(), { priority: 'background', deadlineMs: 5000 });
        expect(() => runner.run(makeRequest(), { priority: 'background', deadlineMs: 5000 })).toThrow(ApiError);
        await Promise.all([active, queued]);
        await runner.close();
    });

    test('timeout terminates the worker, resolves a structured error, and releases the slot', async () => {
        const runner = makeRunner();
        const start = Date.now();
        const timedOut = await runner.run(makeRequest({ behavior: 'sleep', ms: 2000 }), {
            priority: 'foreground',
            deadlineMs: 100,
        });
        expect(Date.now() - start).toBeLessThan(1500);
        expect(timedOut.ok).toBe(false);
        if (!timedOut.ok) expect(timedOut.error.code).toBe('timeout');

        // The slot is free again: a follow-up job completes normally.
        const next = await runner.run(makeRequest(), { priority: 'foreground', deadlineMs: 5000 });
        expect(next.ok).toBe(true);
        await runner.close();
    });

    test('a crashing worker resolves a structured error and releases the slot', async () => {
        const runner = makeRunner();
        const crashed = await runner.run(makeRequest({ behavior: 'crash' }), {
            priority: 'foreground',
            deadlineMs: 5000,
        });
        expect(crashed.ok).toBe(false);
        if (!crashed.ok) expect(crashed.error.code).toBe('crashed');

        const next = await runner.run(makeRequest(), { priority: 'foreground', deadlineMs: 5000 });
        expect(next.ok).toBe(true);
        await runner.close();
    });

    test('a worker that exits without replying resolves a structured error', async () => {
        const runner = makeRunner();
        const exited = await runner.run(makeRequest({ behavior: 'exit' }), {
            priority: 'foreground',
            deadlineMs: 5000,
        });
        expect(exited.ok).toBe(false);
        if (!exited.ok) expect(exited.error.code).toBe('crashed');
        await runner.close();
    });

    test('a malformed worker response resolves a structured error', async () => {
        const runner = makeRunner();
        const malformed = await runner.run(makeRequest({ behavior: 'malformed' }), {
            priority: 'foreground',
            deadlineMs: 5000,
        });
        expect(malformed.ok).toBe(false);
        if (!malformed.ok) expect(malformed.error.code).toBe('invalid-response');
        await runner.close();
    });

    test('a half-valid response ({ok:true} without result) resolves instead of hanging', async () => {
        const runner = makeRunner();
        const halfValid = await runner.run(makeRequest({ behavior: 'malformed-ok' }), {
            priority: 'foreground',
            deadlineMs: 5000,
        });
        expect(halfValid.ok).toBe(false);
        if (!halfValid.ok) expect(halfValid.error.code).toBe('invalid-response');
        await runner.close();
    });

    test('a structured document error passes through untouched', async () => {
        const runner = makeRunner();
        const failed = await runner.run(makeRequest({ behavior: 'document-error' }), {
            priority: 'foreground',
            deadlineMs: 5000,
        });
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
        const response = await runner.run(makeRequest({ behavior: 'echo-buffers' }, [buffer]), {
            priority: 'foreground',
            deadlineMs: 5000,
        });
        expect(buffer.byteLength).toBe(0); // detached from the sender
        expect(JSON.parse(responseBody(response)).receivedBytes).toEqual([5]);
        await runner.close();
    });

    test('an export result buffer arrives intact through the response transfer list', async () => {
        const runner = makeRunner();
        const response = await runner.run(makeExportRequest({ behavior: 'export-ok' }), {
            priority: 'foreground',
            deadlineMs: 5000,
        });
        expect([...new Uint8Array(exportBytes(response))]).toEqual([9, 8, 7, 6]);
        await runner.close();
    });

    test('export media buffers transfer (detach) to the worker and arrive intact', async () => {
        const runner = makeRunner();
        const media = [new Uint8Array([1, 2, 3]).buffer, new Uint8Array([4, 5, 6, 7]).buffer];
        const response = await runner.run(makeMediaExportRequest({ behavior: 'export-echo-media' }, media), {
            priority: 'foreground',
            deadlineMs: 5000,
        });
        expect(media.map((buffer) => buffer.byteLength)).toEqual([0, 0]); // detached from the sender
        expect(JSON.parse(Buffer.from(exportBytes(response)).toString('utf-8'))).toEqual([3, 4]);
        await runner.close();
    });

    test('an export response without export bytes resolves as invalid-response', async () => {
        const runner = makeRunner();
        const malformed = await runner.run(makeExportRequest({ behavior: 'export-malformed' }), {
            priority: 'foreground',
            deadlineMs: 5000,
        });
        expect(malformed.ok).toBe(false);
        if (!malformed.ok) expect(malformed.error.code).toBe('invalid-response');
        await runner.close();
    });

    test('import bytes transfer to the worker and the snapshot returns intact', async () => {
        const runner = makeRunner();
        const data = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer;
        const response = await runner.run(makeImportRequest({ behavior: 'import-ok' }, data), {
            priority: 'foreground',
            deadlineMs: 5000,
        });
        expect(data.byteLength).toBe(0); // detached from the sender
        expect(JSON.parse(importSnapshot(response)).received).toBe(6);
        await runner.close();
    });

    test('an import response without snapshot bytes resolves as invalid-response', async () => {
        const runner = makeRunner();
        const malformed = await runner.run(makeImportRequest({ behavior: 'import-malformed' }), {
            priority: 'foreground',
            deadlineMs: 5000,
        });
        expect(malformed.ok).toBe(false);
        if (!malformed.ok) expect(malformed.error.code).toBe('invalid-response');
        await runner.close();
    });

    test('aborting a queued job removes it before any worker runs it', async () => {
        const runner = makeRunner();
        const active = runner.run(makeRequest({ behavior: 'sleep', ms: 150 }), {
            priority: 'foreground',
            deadlineMs: 5000,
        });
        await Bun.sleep(10);
        const controller = new AbortController();
        const queued = runner.run(makeRequest(), {
            priority: 'foreground',
            deadlineMs: 5000,
            signal: controller.signal,
        });
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
            priority: 'foreground',
            deadlineMs: 5000,
            signal: controller.signal,
        });
        await Bun.sleep(20);
        controller.abort();
        const canceled = await activePromise;
        expect(Date.now() - start).toBeLessThan(1000);
        expect(canceled.ok).toBe(false);
        if (!canceled.ok) expect(canceled.error.code).toBe('canceled');

        const next = await runner.run(makeRequest(), { priority: 'foreground', deadlineMs: 5000 });
        expect(next.ok).toBe(true);
        await runner.close();
    });

    test('close() rejects queued work, stops admission, and terminates active workers after grace', async () => {
        const runner = makeRunner({ closeGraceMs: 50 });
        const active = runner.run(makeRequest({ behavior: 'sleep', ms: 2000 }), {
            priority: 'foreground',
            deadlineMs: 5000,
        });
        await Bun.sleep(10);
        const queued = runner.run(makeRequest(), { priority: 'foreground', deadlineMs: 5000 });

        await runner.close();
        const [activeResult, queuedResult] = await Promise.all([active, queued]);
        expect(activeResult.ok).toBe(false);
        if (!activeResult.ok) expect(activeResult.error.code).toBe('shutdown');
        expect(queuedResult.ok).toBe(false);
        if (!queuedResult.ok) expect(queuedResult.error.code).toBe('shutdown');

        expect(() => runner.run(makeRequest(), { priority: 'foreground', deadlineMs: 5000 })).toThrow(ApiError);
    });
});
