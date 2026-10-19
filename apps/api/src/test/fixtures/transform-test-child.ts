// Scriptable stand-in for the document-transform child process, driven by a `test`
// field the runner tests smuggle onto the request (IPC serialization carries it
// through). Lets the runner suite exercise timeout/crash/signal/malformed/copy and
// memory-limit behavior without heavy document jobs.

import { readFileSync } from 'node:fs';
import {
    type ChildRequestEnvelope,
    type ChildResponseEnvelope,
    type ExportMedia,
    type ParentMediaReply,
    toTransformError,
} from '../../lib/document/transform/protocol';

type TestDirective = {
    behavior?:
        | 'ok'
        | 'sleep'
        | 'crash'
        | 'exit'
        | 'signal'
        | 'oom-reply'
        | 'allocate'
        | 'limits'
        | 'malformed'
        | 'malformed-ok'
        | 'malformed-warnings'
        | 'echo-buffers'
        | 'document-error'
        | 'document-error-bad-status'
        | 'export-ok'
        | 'export-bytes'
        | 'export-echo-media'
        | 'export-warn'
        | 'export-malformed'
        | 'import-ok'
        | 'import-malformed'
        | 'import-doc-malformed-images';
    ms?: number;
    // Dies before acknowledging the job, as a child that fails to load does.
    beforeAck?: boolean;
    signal?: NodeJS.Signals;
    heap?: 'objects' | 'strings' | 'buffers';
    bytes?: number;
    mediaNames?: unknown[];
};

// The three shapes an allocation failure takes under the limit: JSC aborts on objects, segfaults on strings, and throws
// a RangeError for ArrayBuffers. Past 2 GB the limit was not applied, and the test must fail, not the host.
function allocate(heap: TestDirective['heap']): never {
    const keep: unknown[] = [];
    const every = heap === 'buffers' ? 1 : 10_000;
    for (let i = 0; ; i++) {
        if (heap === 'objects') keep.push({ a: i, b: { c: i }, d: [i, i + 1] });
        else if (heap === 'strings') keep.push(`${'x'.repeat(1000)}${i}`);
        else keep.push(new Uint8Array(64 * 1024 * 1024).fill(1));
        if (i % every === 0 && process.memoryUsage.rss() > 2 * 1024 ** 3) throw new Error('memory limit not applied');
    }
}

const send = (message: unknown) => process.send?.(message);

let onMediaReply: ((media: ExportMedia[]) => void) | undefined;

// Asks for media as an export's renderer does, and waits for the runner's reply.
function askForMedia(jobId: number, mediaNames: unknown[]): Promise<ExportMedia[]> {
    return new Promise((resolve) => {
        onMediaReply = resolve;
        send({ jobId, mediaNames });
    });
}

process.on('message', async (message: ChildRequestEnvelope | ParentMediaReply) => {
    if ('media' in message) {
        onMediaReply?.(message.media);
        return;
    }
    const { jobId, request } = message;
    const directive = (request as { test?: TestDirective }).test ?? {};
    if (directive.beforeAck && directive.behavior === 'signal') process.kill(process.pid, directive.signal);
    if (directive.beforeAck) process.exit(1);
    send({ jobId, ack: true });
    const startedAt = Date.now();

    switch (directive.behavior) {
        case 'crash':
            // A macrotask throw is a genuine uncaught exception, so the child exits without a reply.
            setTimeout(() => {
                throw new Error('test child crash');
            }, 0);
            return;
        case 'exit':
            process.exit(1);
            return;
        case 'signal':
            process.kill(process.pid, directive.signal);
            return;
        case 'oom-reply':
            send({ jobId, response: { ok: false, error: toTransformError(new RangeError('Out of memory')) } });
            return;
        case 'allocate':
            try {
                allocate(directive.heap);
            } catch (err) {
                send({ jobId, response: { ok: false, error: toTransformError(err) } });
            }
            return;
        case 'limits': {
            // What the Linux wrapper set, read back from inside.
            const body = JSON.stringify({
                oomScoreAdj: readFileSync('/proc/self/oom_score_adj', 'utf8').trim(),
                limits: readFileSync('/proc/self/limits', 'utf8'),
                jit: process.env['BUN_JSC_jitMemoryReservationSize'],
            });
            send({ jobId, response: { ok: true, result: { body }, warnings: [] } });
            return;
        }
        case 'malformed':
            send({ nonsense: true });
            return;
        case 'malformed-ok':
            // Right discriminant, missing payload — must not hang the requester.
            send({ jobId, response: { ok: true } });
            return;
        case 'malformed-warnings':
            // Valid envelope and result, junk inside the warnings array.
            send({ jobId, response: { ok: true, result: { body: '{}' }, warnings: [null] } });
            return;
        case 'sleep':
            await Bun.sleep(directive.ms ?? 100);
            break;
        case 'export-ok': {
            const data = new Uint8Array([9, 8, 7, 6]).buffer;
            const response: ChildResponseEnvelope = { jobId, response: { ok: true, result: { data }, warnings: [] } };
            send(response);
            return;
        }
        case 'export-bytes': {
            // A result of the size asked for, so the benchmark can time what the parent spends receiving it.
            const data = new ArrayBuffer(directive.bytes ?? 0);
            const response: ChildResponseEnvelope = { jobId, response: { ok: true, result: { data }, warnings: [] } };
            send(response);
            return;
        }
        case 'export-warn': {
            // A success that carries a warning payload, a transform time and a peak, the dimensions the runner's job
            // log derives from the response.
            const data = new Uint8Array([1]).buffer;
            const response: ChildResponseEnvelope = {
                jobId,
                response: { ok: true, result: { data }, warnings: [{ code: 'corrupt-blobs-skipped', count: 3 }] },
                transformMs: 2,
                peakRssBytes: 1234,
            };
            send(response);
            return;
        }
        case 'export-echo-media': {
            // An export asks for the media it names; echo the names and sizes that arrived.
            const media = await askForMedia(jobId, directive.mediaNames ?? []);
            const sizes = new TextEncoder().encode(
                JSON.stringify(media.map((item) => [item.name, item.data.byteLength])),
            );
            const data = sizes.buffer as ArrayBuffer;
            const response: ChildResponseEnvelope = { jobId, response: { ok: true, result: { data }, warnings: [] } };
            send(response);
            return;
        }
        case 'export-malformed':
            // Right discriminant, result missing the export payload.
            send({ jobId, response: { ok: true, result: {}, warnings: [] } });
            return;
        case 'import-ok': {
            // Echo how many bytes arrived.
            const received = 'data' in request ? request.data.byteLength : -1;
            const snapshotJson = new TextEncoder().encode(JSON.stringify({ received })).buffer as ArrayBuffer;
            const response: ChildResponseEnvelope = {
                jobId,
                response: { ok: true, result: { snapshotJson }, warnings: [] },
            };
            send(response);
            return;
        }
        case 'import-malformed':
            // Right discriminant, result missing the snapshot payload.
            send({ jobId, response: { ok: true, result: {}, warnings: [] } });
            return;
        case 'import-doc-malformed-images': {
            // A docx import's update is there, but the images array holds junk.
            const update = new Uint8Array([1, 2]).buffer as ArrayBuffer;
            send({ jobId, response: { ok: true, result: { update, images: [{}] }, warnings: [] } });
            return;
        }
        case 'document-error': {
            const response: ChildResponseEnvelope = {
                jobId,
                response: { ok: false, error: { code: 'transform-failed', status: 422, message: 'bad document' } },
            };
            send(response);
            return;
        }
        case 'document-error-bad-status':
            // status rides into `throw new ApiError(status, …)` on the main thread —
            // a non-HTTP value must be refused at the boundary, not thrown as-is.
            send({
                jobId,
                response: { ok: false, error: { code: 'transform-failed', status: '413', message: 'bad status' } },
            });
            return;
        default:
            break;
    }

    const updates = 'source' in request ? request.source.updates : [];
    const body = JSON.stringify({
        startedAt,
        endedAt: Date.now(),
        receivedBytes: updates.map((u) => u.data.byteLength),
    });
    const response: ChildResponseEnvelope = {
        jobId,
        response: { ok: true, result: { body }, warnings: [] },
    };
    send(response);
});

process.on('disconnect', () => process.exit(0));
