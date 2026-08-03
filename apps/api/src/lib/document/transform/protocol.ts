import type { YjsStatePayload } from '../../collab/yjs-loader';

// Closed request/response unions crossing the document-transform Worker boundary.
// Only clone-safe primitives and ArrayBuffers ride here — never Mount, database,
// Y.Doc, or other class instances, and never module/function names user input
// could influence. Phase 2 carries the eigensheets preview and sheet exports;
// imports and doc/slides operations join the union in later phases.

// `pdf-html` is the HTML stage of the PDF export — WeasyPrint stays a main-thread
// subprocess, so the Worker returns the document it renders from.
export type SheetExportFormat = 'html' | 'xlsx' | 'pdf-html';

// A job is everything a caller decides; the shared main-thread orchestration
// (run-transform.ts) captures the Yjs source and completes it into a request.
export type PreviewTransformJob = { kind: 'preview'; documentType: 'eigensheets' };

// `title` is the stripped document name — the Worker has no DrivePath.
export type ExportTransformJob = {
    kind: 'export';
    documentType: 'eigensheets';
    format: SheetExportFormat;
    title: string;
};

export type DocumentTransformJob = PreviewTransformJob | ExportTransformJob;

export type DocumentTransformRequest = DocumentTransformJob & { source: YjsStatePayload };

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
// Exports are binary and can be large: they travel as a transferred ArrayBuffer,
// never as a structured-clone copy.
export type ExportWorkerResult = { data: ArrayBuffer };

export type DocumentTransformResponse<Result = PreviewResult | ExportWorkerResult> =
    | { ok: true; result: Result; warnings: TransformWarning[] }
    | { ok: false; error: TransformError };

export type WorkerRequestEnvelope = { jobId: number; request: DocumentTransformRequest };
export type WorkerResponseEnvelope = { jobId: number; response: DocumentTransformResponse; transformMs?: number };

// Large binary inputs move by ownership transfer, not structured-clone copy. Every
// request kind carries a Yjs source today; a future kind with different payloads
// (import bytes) fails to compile here until it is handled.
export function transferListOf(request: DocumentTransformRequest): ArrayBuffer[] {
    const buffers: ArrayBuffer[] = [];
    if (request.source.snapshot) buffers.push(request.source.snapshot.data);
    for (const update of request.source.updates) buffers.push(update.data);
    return buffers;
}

// Buffers from TextEncoder/ExcelJS can be views over a larger pool, and a transfer
// hands over the WHOLE backing buffer — copy to an exact standalone one first.
export function toTransferableBuffer(bytes: Uint8Array): ArrayBuffer {
    const out = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(out).set(bytes);
    return out;
}
