import type { YjsStatePayload } from '../../collab/yjs-loader';

// Closed request/response unions crossing the document-transform Worker boundary.
// Only clone-safe primitives and ArrayBuffers ride here — never Mount, database,
// Y.Doc, or other class instances, and never module/function names user input
// could influence. Phase 2 carries the eigensheets preview, sheet exports and
// xlsx import; doc/slides operations join the union in later phases.

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

// Pure conversion of uploaded bytes: the Worker learns nothing about the
// destination — no owner, mount, ACL or path. The formats stay narrow until
// Phase 3 widens them for DOCX/eigendoc.
export type ImportTransformJob = { kind: 'import'; sourceFormat: 'xlsx'; targetType: 'eigensheets' };

// Preview and export read the persisted collaborative document; import does not.
export type CollabTransformJob = PreviewTransformJob | ExportTransformJob;
export type DocumentTransformJob = CollabTransformJob | ImportTransformJob;

export type DocumentTransformRequest =
    | (CollabTransformJob & { source: YjsStatePayload })
    | (ImportTransformJob & { data: ArrayBuffer });

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
// UTF-8 bytes of the lean Sheet[] JSON — the main thread commits the string
// without parsing it.
export type ImportWorkerResult = { snapshotJson: ArrayBuffer };

export type TransformResult = PreviewResult | ExportWorkerResult | ImportWorkerResult;

export type DocumentTransformResponse<Result = TransformResult> =
    | { ok: true; result: Result; warnings: TransformWarning[] }
    | { ok: false; error: TransformError };

export type WorkerRequestEnvelope = { jobId: number; request: DocumentTransformRequest };
export type WorkerResponseEnvelope = { jobId: number; response: DocumentTransformResponse; transformMs?: number };

// Large binary inputs and outputs move by ownership transfer, not structured-clone
// copy. A future request kind with a different payload fails to compile here until
// it is handled.
export function transferListOf(request: DocumentTransformRequest): ArrayBuffer[] {
    if (request.kind === 'import') return [request.data];
    const buffers: ArrayBuffer[] = [];
    if (request.source.snapshot) buffers.push(request.source.snapshot.data);
    for (const update of request.source.updates) buffers.push(update.data);
    return buffers;
}

// The Worker's side of the same rule: binary results are transferred, a preview
// body is a small clone.
export function transferListOfResult(response: DocumentTransformResponse): ArrayBuffer[] {
    if (!response.ok) return [];
    if ('data' in response.result) return [response.result.data];
    if ('snapshotJson' in response.result) return [response.result.snapshotJson];
    return [];
}

// Buffers from TextEncoder/ExcelJS can be views over a larger pool, and a transfer
// hands over the WHOLE backing buffer — copy to an exact standalone one first.
export function toTransferableBuffer(bytes: Uint8Array): ArrayBuffer {
    const out = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(out).set(bytes);
    return out;
}
