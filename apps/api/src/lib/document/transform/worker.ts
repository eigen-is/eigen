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
// never evaluates DOCX/ExcelJS code (and an HTML export never loads ExcelJS).

async function handleRequest(request: DocumentTransformRequest): Promise<DocumentTransformResponse> {
    const { materializeYjsState } = await import('../../collab/yjs-loader');
    const { doc, blobsSkipped } = materializeYjsState(request.source, undefined, 'transform-worker');

    switch (request.kind) {
        case 'preview': {
            const { renderEigensheetsPreviewBody } = await import('../../preview/eigensheets-preview');
            const { body, warnings } = renderEigensheetsPreviewBody(doc);
            if (blobsSkipped > 0) warnings.push({ code: 'corrupt-blobs-skipped', count: blobsSkipped });
            return { ok: true, result: { body }, warnings };
        }
        case 'export': {
            const { renderEigensheetsExport } = await import('../../export/sheets/transform');
            const { data, warnings } = await renderEigensheetsExport(doc, request.format, request.title);
            if (blobsSkipped > 0) warnings.push({ code: 'corrupt-blobs-skipped', count: blobsSkipped });
            return { ok: true, result: { data }, warnings };
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
    // Export bytes ride the transfer list; a preview body is a small clone.
    postMessage(envelope, response.ok && 'data' in response.result ? [response.result.data] : []);
};
