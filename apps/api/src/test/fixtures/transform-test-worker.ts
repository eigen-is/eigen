// Scriptable stand-in for the document-transform Worker, driven by a `test`
// field the runner tests smuggle onto the request (structured clone carries it
// through). Lets the runner suite exercise timeout/crash/malformed/transfer
// behavior without heavy document jobs.

import type { WorkerRequestEnvelope, WorkerResponseEnvelope } from '../../lib/document/transform/protocol';

type TestDirective = {
    behavior?: 'ok' | 'sleep' | 'crash' | 'exit' | 'malformed' | 'malformed-ok' | 'echo-buffers' | 'document-error';
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
        case 'sleep':
            await Bun.sleep(directive.ms ?? 100);
            break;
        case 'document-error': {
            const response: WorkerResponseEnvelope = {
                jobId,
                response: { ok: false, error: { code: 'transform-failed', status: 422, message: 'bad document' } },
            };
            postMessage(response);
            return;
        }
        default:
            break;
    }

    const body = JSON.stringify({
        startedAt,
        endedAt: Date.now(),
        receivedBytes: request.source.updates.map((update) => update.data.byteLength),
    });
    const response: WorkerResponseEnvelope = {
        jobId,
        response: { ok: true, result: { body }, warnings: [] },
    };
    postMessage(response);
};
