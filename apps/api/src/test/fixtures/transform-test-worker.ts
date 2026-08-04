// Scriptable stand-in for the document-transform Worker, driven by a `test`
// field the runner tests smuggle onto the request (structured clone carries it
// through). Lets the runner suite exercise timeout/crash/malformed/transfer
// behavior without heavy document jobs.

import type { WorkerRequestEnvelope, WorkerResponseEnvelope } from '../../lib/document/transform/protocol';

type TestDirective = {
    behavior?:
        | 'ok'
        | 'sleep'
        | 'crash'
        | 'exit'
        | 'malformed'
        | 'malformed-ok'
        | 'malformed-warnings'
        | 'echo-buffers'
        | 'document-error'
        | 'document-error-bad-status'
        | 'export-ok'
        | 'export-echo-media'
        | 'export-warn'
        | 'export-malformed'
        | 'import-ok'
        | 'import-malformed'
        | 'import-doc-malformed-images';
    ms?: number;
};

declare var self: Worker;

self.onmessage = async (event: MessageEvent<WorkerRequestEnvelope>) => {
    const { jobId, request } = event.data;
    const directive = (request as { test?: TestDirective }).test ?? {};
    const startedAt = Date.now();

    switch (directive.behavior) {
        case 'crash':
            // A macrotask throw is a genuine uncaught exception (an async-handler
            // throw would only be an unhandled rejection) → parent onerror fires.
            setTimeout(() => {
                throw new Error('test worker crash');
            }, 0);
            return;
        case 'exit':
            process.exit(1);
            return;
        case 'malformed':
            postMessage({ nonsense: true });
            return;
        case 'malformed-ok':
            // Right discriminant, missing payload — must not hang the requester.
            postMessage({ jobId, response: { ok: true } });
            return;
        case 'malformed-warnings':
            // Valid envelope and result, junk inside the warnings array.
            postMessage({ jobId, response: { ok: true, result: { body: '{}' }, warnings: [null] } });
            return;
        case 'sleep':
            await Bun.sleep(directive.ms ?? 100);
            break;
        case 'export-ok': {
            // Export results ride the response transfer list, never a clone.
            const data = new Uint8Array([9, 8, 7, 6]).buffer;
            const response: WorkerResponseEnvelope = { jobId, response: { ok: true, result: { data }, warnings: [] } };
            postMessage(response, [data]);
            return;
        }
        case 'export-warn': {
            // A success that carries a warning payload and a transform time, the two
            // dimensions the runner's job log derives from the response.
            const data = new Uint8Array([1]).buffer;
            const response: WorkerResponseEnvelope = {
                jobId,
                response: { ok: true, result: { data }, warnings: [{ code: 'corrupt-blobs-skipped', count: 3 }] },
                transformMs: 2,
            };
            postMessage(response, [data]);
            return;
        }
        case 'export-echo-media': {
            // Doc/slides exports carry prepared media on the same transfer list.
            const media = 'media' in request ? request.media : [];
            const sizes = new TextEncoder().encode(JSON.stringify(media.map((item) => item.data.byteLength)));
            const data = sizes.buffer as ArrayBuffer;
            const response: WorkerResponseEnvelope = { jobId, response: { ok: true, result: { data }, warnings: [] } };
            postMessage(response, [data]);
            return;
        }
        case 'export-malformed':
            // Right discriminant, result missing the export payload.
            postMessage({ jobId, response: { ok: true, result: {}, warnings: [] } });
            return;
        case 'import-ok': {
            // Import snapshots ride the transfer list too; echo what arrived.
            const received = 'data' in request ? request.data.byteLength : -1;
            const snapshotJson = new TextEncoder().encode(JSON.stringify({ received })).buffer as ArrayBuffer;
            const response: WorkerResponseEnvelope = {
                jobId,
                response: { ok: true, result: { snapshotJson }, warnings: [] },
            };
            postMessage(response, [snapshotJson]);
            return;
        }
        case 'import-malformed':
            // Right discriminant, result missing the snapshot payload.
            postMessage({ jobId, response: { ok: true, result: {}, warnings: [] } });
            return;
        case 'import-doc-malformed-images': {
            // A docx import's update is there, but the images array holds junk.
            const update = new Uint8Array([1, 2]).buffer as ArrayBuffer;
            postMessage({ jobId, response: { ok: true, result: { update, images: [{}] }, warnings: [] } }, [update]);
            return;
        }
        case 'document-error': {
            const response: WorkerResponseEnvelope = {
                jobId,
                response: { ok: false, error: { code: 'transform-failed', status: 422, message: 'bad document' } },
            };
            postMessage(response);
            return;
        }
        case 'document-error-bad-status': {
            // status rides into `throw new ApiError(status, …)` on the main thread —
            // a non-HTTP value must be refused at the boundary, not thrown as-is.
            postMessage({
                jobId,
                response: { ok: false, error: { code: 'transform-failed', status: '413', message: 'bad status' } },
            });
            return;
        }
        default:
            break;
    }

    const updates = 'source' in request ? request.source.updates : [];
    const body = JSON.stringify({
        startedAt,
        endedAt: Date.now(),
        receivedBytes: updates.map((u) => u.data.byteLength),
    });
    const response: WorkerResponseEnvelope = {
        jobId,
        response: { ok: true, result: { body }, warnings: [] },
    };
    postMessage(response);
};
