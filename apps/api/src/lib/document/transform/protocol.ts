import type { YjsStatePayload } from '../../collab/yjs-loader';

// Closed request/response unions crossing the document-transform Worker boundary.
// Only clone-safe primitives and ArrayBuffers ride here — never Mount, database,
// Y.Doc, or other class instances, and never module/function names user input
// could influence. Phase 1 carries the eigensheets preview; sheet exports/imports
// and doc/slides operations join the union in later phases.

export type DocumentTransformRequest = {
    kind: 'preview';
    documentType: 'eigensheets';
    source: YjsStatePayload;
};

export type TransformWarning =
    | { code: 'recalc-failed'; message: string }
    | { code: 'corrupt-blobs-skipped'; count: number }
    | { code: 'byte-guard-truncated'; bytes: number };

// Small stable codes; `status` carries an HTTP status for controlled document
// errors. Never structured-clone ApiError/Error instances across the boundary.
export type TransformError = {
    code: 'transform-failed' | 'timeout' | 'crashed' | 'invalid-response' | 'canceled' | 'shutdown';
    status?: number;
    message: string;
};

export type PreviewResult = { body: string };

export type DocumentTransformResponse =
    | { ok: true; result: PreviewResult; warnings: TransformWarning[] }
    | { ok: false; error: TransformError };

export type WorkerRequestEnvelope = { jobId: number; request: DocumentTransformRequest };
export type WorkerResponseEnvelope = { jobId: number; response: DocumentTransformResponse; transformMs?: number };

// Large binary inputs move by ownership transfer, not structured-clone copy.
export function transferListOf(request: DocumentTransformRequest): ArrayBuffer[] {
    const buffers: ArrayBuffer[] = [];
    if (request.source.snapshot) buffers.push(request.source.snapshot.data);
    for (const update of request.source.updates) buffers.push(update.data);
    return buffers;
}
