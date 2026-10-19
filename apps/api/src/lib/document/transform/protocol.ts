import type { NormalStyle, PageSetup } from '@workspace/lib/docs/eigendoc';
import type { ImageDimensions } from '@workspace/lib/types/drive';
import type { YjsStatePayload } from '../../collab/yjs-loader';
import { ApiError, isOutOfMemory } from '../../core/errors';

// Closed request/response unions crossing the boundary to the document-transform process.
// Only serializable primitives, ArrayBuffers and Maps of primitives ride here — never
// Mount, database, Y.Doc, or other class instances, and never module/function names
// user input could influence. Every eigensheets/eigendoc/eigenslides/eigenvector preview,
// every vCard, message and calendar preview, every HTML/PDF/XLSX/DOCX/PPTX export, the xlsx, docx and pptx imports
// and the search content extraction ride these unions.

// `pdf-html` is the HTML stage of the PDF export — WeasyPrint stays a main-thread
// subprocess, so the transform returns the document it renders from.
export type SheetExportFormat = 'html' | 'xlsx' | 'pdf-html';
export type DocumentExportFormat = 'html' | 'pdf-html';
// Only eigendoc exports to docx and only eigenslides to pptx; the other routes reject them.
export type EigendocExportFormat = DocumentExportFormat | 'docx';
export type SlidesExportFormat = DocumentExportFormat | 'pptx';
// Vector exports the drawing's own SVG, or that SVG on a page WeasyPrint renders to PDF.
export type VectorExportFormat = 'svg' | 'pdf-html';

// What an HTML export is for: the download a browser opens, or the document WeasyPrint prints.
export type HtmlExportMode = 'screen' | 'pdf';

// Out of html-document.ts, which loads jsdom, so an xlsx export never evaluates it.
export function htmlExportMode(format: DocumentExportFormat): HtmlExportMode {
    return format === 'pdf-html' ? 'pdf' : 'screen';
}

// Document media crossing the boundary: prepared on the main thread for an export
// (Mount I/O + screen previews), extracted from the upload by a docx import.
export type TransformMedia = { name: string; contentType: string; data: ArrayBuffer };

// An export's media; only a docx's or pptx's raster carries the thumbnail Worker's width and height. Their arms add an
// SVG's size inside the transform process.
export type ExportMedia = TransformMedia & Partial<ImageDimensions>;

// A job is everything a caller decides; the shared main-thread orchestration
// (run-transform.ts) captures the Yjs source and completes it into a request.
// Previews reference media by URL, so no bytes cross for a preview. (Vector renders to
// an SVG served as-is; the URL map resolves its <image> hrefs.)
export type CollabPreviewJob = {
    kind: 'preview';
    documentType: 'eigensheets' | 'eigendoc' | 'eigenslides' | 'eigenvector';
    mediaUrls: Map<string, string>;
};

// A .vcf, an .eml and an .ics hold no collaborative document: they preview from their own bytes, which
// ride as a buffer the way an upload does.
export type VCardPreviewJob = { kind: 'preview'; documentType: 'vcard' };
export type EmlPreviewJob = { kind: 'preview'; documentType: 'eml' };
export type IcsPreviewJob = { kind: 'preview'; documentType: 'ics' };
export type BytesPreviewJob = VCardPreviewJob | EmlPreviewJob | IcsPreviewJob;

// `title` is the document title the renderer embeds — the transform has no DrivePath.
// (Sheets and slides strip the eigen extension; eigendoc's <title> keeps the full
// container name, frozen output.)
export type ExportTransformJob =
    | {
          kind: 'export';
          documentType: 'eigensheets';
          format: SheetExportFormat;
          title: string;
          media: ExportMedia[];
      }
    | {
          kind: 'export';
          documentType: 'eigendoc';
          format: EigendocExportFormat;
          title: string;
          media: ExportMedia[];
          // The docx absolutizes root-relative links with it; the transform reads no config.
          publicOrigin: string | undefined;
      }
    | {
          kind: 'export';
          documentType: 'eigenslides';
          format: SlidesExportFormat;
          title: string;
          media: ExportMedia[];
      }
    | {
          kind: 'export';
          documentType: 'eigenvector';
          format: VectorExportFormat;
          title: string;
          media: ExportMedia[];
      };

// Search reindexing: the same captured document, read for its body text only. The
// transform returns text, never the materialized Sheet[]/deck/ProseMirror JSON.
export type ExtractTextJob = {
    kind: 'extract-text';
    documentType: 'eigensheets' | 'eigendoc' | 'eigenslides' | 'eigenvector';
};

// Pure conversion of uploaded bytes: the transform learns nothing about the
// destination — no owner, mount, ACL or path. One arm per supported source format,
// so an impossible pairing (xlsx into an eigendoc) does not compile.
export type SheetsImportJob = { kind: 'import'; sourceFormat: 'xlsx'; targetType: 'eigensheets' };
export type DocImportJob = {
    kind: 'import';
    sourceFormat: 'docx';
    targetType: 'eigendoc';
    // Links into this instance come back root-relative with it; the transform reads no config.
    publicOrigin: string | undefined;
};
export type SlidesImportJob = {
    kind: 'import';
    sourceFormat: 'pptx';
    targetType: 'eigenslides';
    // The open deck's frame, which Import slides… fits a file of another size into, letterboxed. A Convert passes none:
    // its new deck takes the slide size nearest the file's.
    frame?: { width: number; height: number };
    // The upload cap, which bounds the pictures' inflated bytes too; the transform reads no config.
    maxMediaBytes: number;
};
export type ImportTransformJob = SheetsImportJob | DocImportJob | SlidesImportJob;

// Preview, export and search extraction read the persisted collaborative document; the
// bytes-sourced jobs (the vCard, message and calendar previews, both imports) carry their own input instead.
export type CollabTransformJob = CollabPreviewJob | ExportTransformJob | ExtractTextJob;
export type BytesTransformJob = BytesPreviewJob | ImportTransformJob;

export type DocumentTransformRequest =
    | (CollabTransformJob & { source: YjsStatePayload })
    | (BytesTransformJob & { data: ArrayBuffer });

// The warnings that count what a read skipped or an import left out.
export type CountedWarningCode =
    | 'corrupt-blobs-skipped'
    | 'blocks-flattened'
    | 'images-unshown'
    | 'images-dropped'
    | 'mirrors-dropped'
    | 'graphics-dropped'
    | 'tables-dropped'
    | 'charts-dropped'
    | 'diagrams-dropped'
    | 'objects-dropped'
    | 'shapes-simplified'
    | 'fills-simplified'
    | 'text-simplified'
    | 'section-pages-dropped'
    | 'even-bands-dropped'
    | 'band-images-unanchored'
    | 'band-content-dropped'
    | 'band-blocks-cut';

export type TransformWarning =
    | { code: 'recalc-failed'; message: string }
    | { code: 'byte-guard-truncated'; bytes: number }
    | { code: CountedWarningCode; count: number };

// Small stable codes; `status` carries an HTTP status for controlled document
// errors. Never ApiError/Error instances across the boundary. `out-of-memory`: the
// child caught one, or died of one after it took the job.
export type TransformError = {
    code: 'transform-failed' | 'out-of-memory' | 'timeout' | 'crashed' | 'invalid-response' | 'canceled' | 'shutdown';
    status?: number;
    message: string;
};

// What a throw inside the child becomes: an ApiError keeps its status, so controlled
// document errors keep their HTTP semantics.
export function toTransformError(err: unknown): TransformError {
    if (isOutOfMemory(err)) return { code: 'out-of-memory', message: err.message };
    return {
        code: 'transform-failed',
        ...(err instanceof ApiError && { status: err.status }),
        message: err instanceof Error ? err.message : String(err),
    };
}

// A doc's preview carries its page and its Normal, which quick look and the hero draw it on and in.
export type PreviewResult = { body: string; page?: PageSetup; style?: NormalStyle };
// Body text for the content index, already capped by the extractor — small like a
// preview body.
export type ExtractTextResult = { text: string };
export type ExportWorkerResult = { data: ArrayBuffer };
// UTF-8 bytes of the lean Sheet[] JSON — the main thread commits the string
// without parsing it.
export type SheetsImportWorkerResult = { snapshotJson: ArrayBuffer };
// A ready Yjs update plus the images extracted from the docx, its page and its Normal: the main thread
// only commits the update, the page and the Normal and writes the media through Mount.
export type DocImportWorkerResult = {
    update: ArrayBuffer;
    page: PageSetup;
    style: NormalStyle;
    images: TransformMedia[];
};
// A pptx's update plus its pictures: the main thread only applies the update and writes the media through Mount.
export type SlidesImportWorkerResult = { update: ArrayBuffer; images: TransformMedia[] };

export type TransformResult =
    | PreviewResult
    | ExtractTextResult
    | ExportWorkerResult
    | SheetsImportWorkerResult
    | DocImportWorkerResult
    | SlidesImportWorkerResult;

// Which result a job kind produces. The runner proves the pairing at runtime with
// resultMatchesRequest; run-transform.ts narrows to this once so no caller re-checks.
// Keyed off the job discriminants, so a captured request (job + source) resolves the
// same. A future arm resolves to `never` and fails to compile at its callsite.
export type TransformResultFor<R extends CollabTransformJob | BytesTransformJob> = R extends { kind: 'preview' }
    ? PreviewResult
    : R extends { kind: 'extract-text' }
      ? ExtractTextResult
      : R extends { kind: 'export' }
        ? ExportWorkerResult
        : R extends { targetType: 'eigensheets' }
          ? SheetsImportWorkerResult
          : R extends { targetType: 'eigendoc' }
            ? DocImportWorkerResult
            : R extends { targetType: 'eigenslides' }
              ? SlidesImportWorkerResult
              : never;

export type DocumentTransformResponse =
    | { ok: true; result: TransformResult; warnings: TransformWarning[] }
    | { ok: false; error: TransformError };

export type ChildRequestEnvelope = { jobId: number; request: DocumentTransformRequest };
// The child's first message: the job arrived, so a death from here on is the job's.
export type ChildAck = { jobId: number; ack: true };
export type ChildResponseEnvelope = {
    jobId: number;
    response: DocumentTransformResponse;
    transformMs?: number;
    peakRssBytes?: number;
};

// The input bytes a job copies to the child, for its log line. A future request kind
// with a different payload fails to compile here until it is handled.
export function inputBytesOf(request: DocumentTransformRequest): number {
    if ('data' in request) return request.data.byteLength;
    let bytes = request.source.snapshot?.data.byteLength ?? 0;
    for (const update of request.source.updates) bytes += update.data.byteLength;
    if (request.kind === 'export') {
        for (const item of request.media) bytes += item.data.byteLength;
    }
    return bytes;
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
        | {
              body?: unknown;
              text?: unknown;
              data?: unknown;
              snapshotJson?: unknown;
              update?: unknown;
              page?: unknown;
              style?: unknown;
              images?: unknown;
          }
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
                        r?.update instanceof ArrayBuffer &&
                        typeof r.page === 'object' &&
                        r.page !== null &&
                        typeof r.style === 'object' &&
                        r.style !== null &&
                        Array.isArray(r.images) &&
                        r.images.every(isTransformMedia)
                    );
                case 'eigenslides':
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

// Buffers from TextEncoder/ExcelJS can be views over a larger pool, and IPC
// serializes a view's WHOLE backing buffer — copy to an exact standalone one first.
export function toTransferableBuffer(bytes: Uint8Array): ArrayBuffer {
    const { buffer } = bytes;
    if (buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength)
        return buffer;
    const out = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(out).set(bytes);
    return out;
}

// Every text result (export documents, the import snapshot JSON) crosses as UTF-8
// bytes the main thread decodes or serves as-is.
export function toTransferableText(text: string): ArrayBuffer {
    return toTransferableBuffer(new TextEncoder().encode(text));
}
