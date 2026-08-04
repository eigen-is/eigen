import type { YjsStatePayload } from '../../collab/yjs-loader';

// Closed request/response unions crossing the document-transform Worker boundary.
// Only clone-safe primitives, ArrayBuffers and Maps of primitives ride here — never
// Mount, database, Y.Doc, or other class instances, and never module/function names
// user input could influence. Phases 2–4 carry every eigensheets/eigendoc/eigenslides preview,
// every HTML/PDF/XLSX/DOCX export, the xlsx and docx imports, and the search content extraction.

// `pdf-html` is the HTML stage of the PDF export — WeasyPrint stays a main-thread
// subprocess, so the Worker returns the document it renders from.
export type SheetExportFormat = 'html' | 'xlsx' | 'pdf-html';
export type DocumentExportFormat = 'html' | 'pdf-html';
// Only eigendoc exports to docx; the slides route rejects the format.
export type EigendocExportFormat = DocumentExportFormat | 'docx';

// Doc/slides media crossing the boundary: prepared on the main thread for an export
// (Mount I/O + screen previews), extracted from the upload by a docx import. The
// bytes always ride as transferred buffers.
export type TransformMedia = { name: string; contentType: string; data: ArrayBuffer };

// A job is everything a caller decides; the shared main-thread orchestration
// (run-transform.ts) captures the Yjs source and completes it into a request.
// Doc/slides previews reference media by URL, so no bytes cross for a preview.
export type PreviewTransformJob =
    | { kind: 'preview'; documentType: 'eigensheets' }
    | { kind: 'preview'; documentType: 'eigendoc' | 'eigenslides'; mediaUrls: Map<string, string> };

// `title` is the document title the renderer embeds — the Worker has no DrivePath.
// (Sheets and slides strip the eigen extension; eigendoc's <title> keeps the full
// container name, frozen output.)
export type ExportTransformJob =
    | { kind: 'export'; documentType: 'eigensheets'; format: SheetExportFormat; title: string }
    | { kind: 'export'; documentType: 'eigendoc'; format: EigendocExportFormat; title: string; media: TransformMedia[] }
    | {
          kind: 'export';
          documentType: 'eigenslides';
          format: DocumentExportFormat;
          title: string;
          media: TransformMedia[];
      };

// Search reindexing: the same captured document, read for its body text only. The
// Worker returns text, never the materialized Sheet[]/deck/ProseMirror JSON.
export type ExtractTextJob = { kind: 'extract-text'; documentType: 'eigensheets' | 'eigendoc' | 'eigenslides' };

// Pure conversion of uploaded bytes: the Worker learns nothing about the
// destination — no owner, mount, ACL or path. One arm per supported source format,
// so an impossible pairing (xlsx into an eigendoc) does not compile.
export type SheetsImportJob = { kind: 'import'; sourceFormat: 'xlsx'; targetType: 'eigensheets' };
export type DocImportJob = { kind: 'import'; sourceFormat: 'docx'; targetType: 'eigendoc' };
export type ImportTransformJob = SheetsImportJob | DocImportJob;

// Preview, export and search extraction read the persisted collaborative document;
// import does not.
export type CollabTransformJob = PreviewTransformJob | ExportTransformJob | ExtractTextJob;

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
// Body text for the content index, already capped by the extractor — a small clone
// like a preview body.
export type ExtractTextResult = { text: string };
// Exports are binary and can be large: they travel as a transferred ArrayBuffer,
// never as a structured-clone copy.
export type ExportWorkerResult = { data: ArrayBuffer };
// UTF-8 bytes of the lean Sheet[] JSON — the main thread commits the string
// without parsing it.
export type SheetsImportWorkerResult = { snapshotJson: ArrayBuffer };
// A ready Yjs update plus the images extracted from the docx: the main thread only
// applies the update and writes the media through Mount.
export type DocImportWorkerResult = { update: ArrayBuffer; images: TransformMedia[] };

export type TransformResult =
    | PreviewResult
    | ExtractTextResult
    | ExportWorkerResult
    | SheetsImportWorkerResult
    | DocImportWorkerResult;

export type DocumentTransformResponse =
    | { ok: true; result: TransformResult; warnings: TransformWarning[] }
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
    if (request.kind === 'export' && 'media' in request) {
        for (const item of request.media) buffers.push(item.data);
    }
    return buffers;
}

// The Worker's side of the same rule: binary results are transferred, text results
// (a preview body, extracted content) are small clones.
export function transferListOfResult(response: DocumentTransformResponse): ArrayBuffer[] {
    if (!response.ok) return [];
    const result = response.result;
    if ('data' in result) return [result.data];
    if ('snapshotJson' in result) return [result.snapshotJson];
    if ('update' in result) return [result.update, ...result.images.map((image) => image.data)];
    return [];
}

// Nested payloads count as shape: resultBytes() sums image byte lengths after the
// runner has already released the job, so junk in here would throw with nobody left
// to settle the request.
function isTransformMedia(value: unknown): boolean {
    const media = value as Partial<TransformMedia> | undefined;
    return (
        typeof media?.name === 'string' && typeof media.contentType === 'string' && media.data instanceof ArrayBuffer
    );
}

// Which result member pairs with which request — the runner checks this at the trust
// boundary, so every seam past it narrows without re-checking. Exhaustive over kind
// (and, for imports, over the type produced), so a future union arm is a compile error
// instead of a silent fallthrough.
export function resultMatchesRequest(request: DocumentTransformRequest, result: unknown): boolean {
    const r = result as
        | { body?: unknown; text?: unknown; data?: unknown; snapshotJson?: unknown; update?: unknown; images?: unknown }
        | undefined;
    switch (request.kind) {
        case 'preview':
            return typeof r?.body === 'string';
        case 'extract-text':
            return typeof r?.text === 'string';
        case 'export':
            return r?.data instanceof ArrayBuffer;
        case 'import':
            switch (request.targetType) {
                case 'eigendoc':
                    return (
                        r?.update instanceof ArrayBuffer && Array.isArray(r.images) && r.images.every(isTransformMedia)
                    );
                case 'eigensheets':
                    return r?.snapshotJson instanceof ArrayBuffer;
            }
    }
}

export function resultBytes(result: TransformResult): number {
    if ('body' in result) return Buffer.byteLength(result.body);
    if ('text' in result) return Buffer.byteLength(result.text);
    if ('data' in result) return result.data.byteLength;
    if ('snapshotJson' in result) return result.snapshotJson.byteLength;
    return result.images.reduce((sum, image) => sum + image.data.byteLength, result.update.byteLength);
}

// Buffers from TextEncoder/ExcelJS can be views over a larger pool, and a transfer
// hands over the WHOLE backing buffer — copy to an exact standalone one first.
export function toTransferableBuffer(bytes: Uint8Array): ArrayBuffer {
    const out = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(out).set(bytes);
    return out;
}

// Every text result (export documents, the import snapshot JSON) crosses as UTF-8
// bytes the main thread decodes or serves as-is.
export function toTransferableText(text: string): ArrayBuffer {
    return toTransferableBuffer(new TextEncoder().encode(text));
}
