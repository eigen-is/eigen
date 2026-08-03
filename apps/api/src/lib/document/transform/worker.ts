import type * as Y from 'yjs';
import {
    type DocumentTransformRequest,
    type DocumentTransformResponse,
    type ExportTransformJob,
    type PreviewTransformJob,
    type TransformWarning,
    transferListOfResult,
    type WorkerRequestEnvelope,
    type WorkerResponseEnvelope,
} from './protocol';

// One-shot document-transform Worker: executes exactly one request, posts one
// response, and is terminated by the runner. Operation dispatch stays a closed
// switch over the request union — nothing from the message can select a module
// or path. Format-specific modules load via dynamic import so a doc preview never
// evaluates the sheet engine, and a slides export never loads lowlight.

async function renderPreview(
    request: PreviewTransformJob,
    doc: Y.Doc,
): Promise<{ body: string; warnings: TransformWarning[] }> {
    switch (request.documentType) {
        case 'eigensheets': {
            const { renderEigensheetsPreviewBody } = await import('../../preview/eigensheets-preview');
            return renderEigensheetsPreviewBody(doc);
        }
        case 'eigendoc': {
            const { renderEigendocPreviewBody } = await import('../../preview/eigendoc-preview');
            return renderEigendocPreviewBody(doc, request.mediaUrls);
        }
        case 'eigenslides': {
            const { renderEigenslidesPreviewBody } = await import('../../preview/eigenslides-preview');
            return renderEigenslidesPreviewBody(doc, request.mediaUrls);
        }
    }
}

async function renderExport(
    request: ExportTransformJob,
    doc: Y.Doc,
): Promise<{ data: ArrayBuffer; warnings: TransformWarning[] }> {
    switch (request.documentType) {
        case 'eigensheets': {
            const { renderEigensheetsExport } = await import('../../export/sheets/transform');
            return renderEigensheetsExport(doc, request.format, request.title);
        }
        case 'eigendoc': {
            // html and pdf-html render the same document — the format only decides
            // what the main thread does with the bytes.
            const { renderEigendocExport } = await import('../../export/doc/transform');
            return renderEigendocExport(doc, request.title, request.media);
        }
        case 'eigenslides': {
            const { renderEigenslidesExport } = await import('../../export/slides/transform');
            return renderEigenslidesExport(doc, request.format, request.title, request.media);
        }
    }
}

async function handleRequest(request: DocumentTransformRequest): Promise<DocumentTransformResponse> {
    // Imports convert uploaded bytes — no document to materialize.
    if (request.kind === 'import') {
        const { importXlsxToSheetsSnapshot } = await import('../../import/sheets/transform');
        const { snapshotJson, warnings } = await importXlsxToSheetsSnapshot(request.data);
        return { ok: true, result: { snapshotJson }, warnings };
    }

    // Preview and export both read the persisted document, so materialization is shared.
    const { materializeYjsState } = await import('../../collab/yjs-loader');
    const { doc, blobsSkipped } = materializeYjsState(request.source, undefined, 'transform-worker');

    switch (request.kind) {
        case 'preview': {
            const { body, warnings } = await renderPreview(request, doc);
            if (blobsSkipped > 0) warnings.push({ code: 'corrupt-blobs-skipped', count: blobsSkipped });
            return { ok: true, result: { body }, warnings };
        }
        case 'export': {
            const { data, warnings } = await renderExport(request, doc);
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
    postMessage(envelope, transferListOfResult(response));
};
