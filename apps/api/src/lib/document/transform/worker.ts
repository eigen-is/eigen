import type {
    DocumentTransformRequest,
    DocumentTransformResponse,
    WorkerRequestEnvelope,
    WorkerResponseEnvelope,
} from './protocol';

// One-shot document-transform Worker: executes exactly one request, posts one
// response, and is terminated by the runner. Operation dispatch stays a closed
// switch over the request union — nothing from the message can select a module
// or path. Format-specific modules load via dynamic import so a sheets preview
// never evaluates DOCX/ExcelJS code (and vice versa in later phases).

async function handleRequest(request: DocumentTransformRequest): Promise<DocumentTransformResponse> {
    switch (request.kind) {
        case 'preview': {
            const { materializeYjsState } = await import('../../collab/yjs-loader');
            const { renderEigensheetsPreviewBody } = await import('../../preview/eigensheets-preview');
            const { doc, blobsSkipped } = materializeYjsState(request.source, undefined, 'transform-worker');
            const { body, warnings } = renderEigensheetsPreviewBody(doc);
            if (blobsSkipped > 0) warnings.push({ code: 'corrupt-blobs-skipped', count: blobsSkipped });
            return { ok: true, result: { body }, warnings };
        }
    }
}

declare var self: Worker;

self.onmessage = async (event: MessageEvent<WorkerRequestEnvelope>) => {
    const { jobId, request } = event.data;
    const startedAt = performance.now();
    let response: DocumentTransformResponse;
    try {
        response = await handleRequest(request);
    } catch (err) {
        // Never structured-clone Error instances — send a small stable shape. An
        // ApiError-like status survives so controlled document errors keep their
        // HTTP semantics across the boundary.
        const status = (err as { status?: unknown }).status;
        response = {
            ok: false,
            error: {
                code: 'transform-failed',
                ...(typeof status === 'number' && { status }),
                message: err instanceof Error ? err.message : String(err),
            },
        };
    }
    const envelope: WorkerResponseEnvelope = { jobId, response, transformMs: performance.now() - startedAt };
    postMessage(envelope);
};
