import type * as Y from 'yjs';
import { ApiError } from '../../core/errors';
import {
    type CollabTransformJob,
    type DocumentTransformRequest,
    type DocumentTransformResponse,
    type ExportTransformJob,
    type ImportTransformJob,
    type PreviewTransformJob,
    type TransformResult,
    type TransformWarning,
    transferListOfResult,
    type WorkerRequestEnvelope,
    type WorkerResponseEnvelope,
} from './protocol';

// One-shot document-transform Worker: executes exactly one request, posts one
// response, and is terminated by the runner. Operation dispatch stays a closed
// switch over the request union — nothing from the message can select a module
// or path. Format-specific modules load via dynamic import so a doc preview never
// evaluates the sheet engine, and a deck export never loads lowlight.

async function renderPreview(
    request: PreviewTransformJob,
    doc: Y.Doc,
): Promise<{ body: string; warnings: TransformWarning[] }> {
    switch (request.documentType) {
        case 'eigensheets': {
            const { renderEigensheetsPreviewBody } = await import('../../preview/eigensheets-render');
            return renderEigensheetsPreviewBody(doc);
        }
        case 'eigendoc': {
            const { renderEigendocPreviewBody } = await import('../../preview/eigendoc-render');
            return renderEigendocPreviewBody(doc, request.mediaUrls);
        }
        case 'eigenslides': {
            const { renderEigenslidesPreviewBody } = await import('../../preview/eigenslides-render');
            return renderEigenslidesPreviewBody(doc, request.mediaUrls);
        }
        case 'eigenvector': {
            const { renderEigenvectorPreviewBody } = await import('../../preview/eigenvector-render');
            return renderEigenvectorPreviewBody(doc, request.mediaUrls);
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
            const { renderEigendocExport } = await import('../../export/doc/transform');
            return renderEigendocExport(doc, request.format, request.title, request.media);
        }
        case 'eigenslides': {
            const { renderEigenslidesExport } = await import('../../export/canvas/transform');
            return renderEigenslidesExport(doc, request.format, request.title, request.media);
        }
        case 'eigenvector': {
            const { renderEigenvectorExport } = await import('../../export/vector/transform');
            return renderEigenvectorExport(doc, request.format, request.title, request.media);
        }
    }
}

async function runImport(request: ImportTransformJob & { data: ArrayBuffer }): Promise<DocumentTransformResponse> {
    switch (request.sourceFormat) {
        case 'xlsx': {
            const { importXlsxToSheetsSnapshot } = await import('../../import/sheets/transform');
            const { snapshotJson, warnings } = await importXlsxToSheetsSnapshot(request.data);
            return { ok: true, result: { snapshotJson }, warnings };
        }
        case 'docx': {
            const { importDocxToEigendocUpdate } = await import('../../import/doc/transform');
            return { ok: true, result: await importDocxToEigendocUpdate(request.data), warnings: [] };
        }
    }
}

// The three document-sourced kinds dispatch off one materialized doc, so the
// skipped-blob warning is appended once by the caller rather than in every arm.
async function renderCollabRequest(
    request: CollabTransformJob,
    doc: Y.Doc,
): Promise<{ result: TransformResult; warnings: TransformWarning[] }> {
    switch (request.kind) {
        case 'preview': {
            const { body, warnings } = await renderPreview(request, doc);
            return { result: { body }, warnings };
        }
        case 'export': {
            const { data, warnings } = await renderExport(request, doc);
            return { result: { data }, warnings };
        }
        case 'extract-text': {
            const { extractCollabText } = await import('../../search/extract-render');
            const { text, warnings } = await extractCollabText(request.documentType, doc);
            return { result: { text }, warnings };
        }
    }
}

async function handleRequest(request: DocumentTransformRequest): Promise<DocumentTransformResponse> {
    // Imports convert uploaded bytes — no document to materialize.
    if (request.kind === 'import') return runImport(request);

    // Preview and export both read the persisted document, so materialization is shared.
    const { materializeYjsState } = await import('../../collab/yjs-loader');
    const { doc, blobsSkipped } = materializeYjsState(request.source, undefined, 'transform-worker');

    const { result, warnings } = await renderCollabRequest(request, doc);
    if (blobsSkipped > 0) warnings.push({ code: 'corrupt-blobs-skipped', count: blobsSkipped });
    return { ok: true, result, warnings };
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
        // ApiError's status survives so controlled document errors keep their HTTP
        // semantics across the boundary.
        response = {
            ok: false,
            error: {
                code: 'transform-failed',
                ...(err instanceof ApiError && { status: err.status }),
                message: err instanceof Error ? err.message : String(err),
            },
        };
    }
    const envelope: WorkerResponseEnvelope = { jobId, response, transformMs: performance.now() - startedAt };
    postMessage(envelope, transferListOfResult(response));
};
