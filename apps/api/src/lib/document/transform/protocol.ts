// The closed request and response unions that cross into the document-transform process, such as a preview, an export,
// an import or a search extract, and the helpers both sides share. Only serializable values ride here: primitives,
// ArrayBuffers and Maps of primitives, never a Mount, a database, a Y.Doc or another class instance, and never a module
// or function name user input could influence.

import type { NormalStyle, PageSetup } from '@workspace/lib/docs/eigendoc';
import type { ImageDimensions } from '@workspace/lib/types/drive';
import type { TextPreviewResult } from '@workspace/lib/types/preview';
import type { SlidePage } from '@workspace/lib/vector';
import type { YjsStatePayload } from '../../collab/yjs-loader';
import { ApiError, isOutOfMemory } from '../../core/errors';

// `pdf-html` is the HTML stage of the PDF export — WeasyPrint stays a main-thread
// subprocess, so the transform returns the document it renders from.
export type SheetExportFormat = 'html' | 'xlsx' | 'pdf-html';
export type DocumentExportFormat = 'html' | 'pdf-html';
// Only eigendoc exports to docx and only eigenslides to pptx; the other routes reject them.
export type EigendocExportFormat = DocumentExportFormat | 'docx';
export type SlidesExportFormat = DocumentExportFormat | 'pptx';
// A drawing exports as one page WeasyPrint renders to PDF; its SVG is the editor's own (packages/ui's canvas image).
export type VectorExportFormat = 'pdf-html';

// What an HTML export is for: the download a browser opens, or the document WeasyPrint prints.
export type HtmlExportMode = 'screen' | 'pdf';

// Out of html-document.ts, which loads jsdom, so an xlsx export never evaluates it.
export function htmlExportMode(format: DocumentExportFormat): HtmlExportMode {
    return format === 'pdf-html' ? 'pdf' : 'screen';
}

// Document media crossing the boundary: prepared on the main thread for an export
// (Mount I/O + screen previews), extracted from the upload by an import.
export type TransformMedia = { name: string; contentType: string; data: ArrayBuffer };

// An export's media; only an Office format's raster carries the thumbnail Worker's width and height. Their arms add an
// SVG's size inside the transform process.
export type ExportMedia = TransformMedia & Partial<ImageDimensions>;

// An export's renderer asks for the media its document names once it has read the document, so the main thread
// prepares only those, while the job holds its slot.
export type ExportMediaLoader = (names: Set<string>) => Promise<ExportMedia[]>;

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
      }
    | {
          kind: 'export';
          documentType: 'eigendoc';
          format: EigendocExportFormat;
          title: string;
          // The docx absolutizes root-relative links with it; the transform reads no config.
          publicOrigin: string | undefined;
      }
    | {
          kind: 'export';
          documentType: 'eigenslides';
          format: SlidesExportFormat;
          title: string;
      }
    | {
          kind: 'export';
          documentType: 'eigenvector';
          format: VectorExportFormat;
          title: string;
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
export type SheetsImportJob = {
    kind: 'import';
    sourceFormat: 'xlsx';
    targetType: 'eigensheets';
    // The upload cap, which bounds the pictures' inflated bytes too; the transform reads no config.
    maxMediaBytes: number;
};
export type DocImportJob = {
    kind: 'import';
    sourceFormat: 'docx';
    targetType: 'eigendoc';
    // Links into this instance come back root-relative with it; the transform reads no config.
    publicOrigin: string | undefined;
    // The upload cap, which bounds the pictures' inflated bytes too; the transform reads no config.
    maxMediaBytes: number;
};
export type SlidesImportJob = {
    kind: 'import';
    sourceFormat: 'pptx';
    targetType: 'eigenslides';
    // The open deck's page, which an inserting Import… fits a file of another size into, letterboxed. A Convert and a
    // replace pass none: the deck takes the slide size nearest the file's, and the file's width.
    deck?: SlidePage;
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

// The warnings that count what a read skipped, an import left out or an export cut.
export const COUNTED_WARNING_CODES = [
    'corrupt-blobs-skipped',
    'blocks-flattened',
    'images-unshown',
    'images-dropped',
    'mirrors-dropped',
    'tables-dropped',
    'tables-simplified',
    'charts-dropped',
    'charts-simplified',
    'diagrams-dropped',
    'diagrams-flattened',
    'objects-dropped',
    'shapes-simplified',
    'fills-simplified',
    'text-simplified',
    'section-pages-dropped',
    'even-bands-dropped',
    'band-images-unanchored',
    'band-content-dropped',
    'bands-cut',
    'sheets-cut',
    'sheets-left-out',
    'conditional-formats-dropped',
    'validations-dropped',
    'validation-prompts-cut',
    'names-dropped',
    'sheet-names-changed',
    'cells-dropped',
    'texts-cut',
    'formulas-dropped',
    'number-formats-dropped',
    'cell-formats-dropped',
    'links-dropped',
    'toc-entries-changed',
] as const;
export type CountedWarningCode = (typeof COUNTED_WARNING_CODES)[number];

export type TransformWarning =
    | { code: 'recalc-failed'; message: string }
    | { code: 'byte-guard-truncated'; bytes: number }
    | { code: CountedWarningCode; count: number };

export type LossCounter = {
    // One loss of this kind; with a source, once per source, so a master's fill is one loss however many slides show it.
    lost(code: CountedWarningCode, source?: object): void;
    // The counts, in the order their codes were first met.
    warnings(): TransformWarning[];
};

// Counts one loss of this kind, where the caller has no source to count it once for.
export type Lost = (code: CountedWarningCode) => void;

// What a reader or a writer left out, counted by kind as it goes.
export function lossCounter(): LossCounter {
    const losses = new Map<CountedWarningCode, { count: number; sources: Set<object> }>();
    return {
        lost: (code, source) => {
            const loss = losses.get(code) ?? { count: 0, sources: new Set() };
            losses.set(code, loss);
            if (source) {
                if (loss.sources.has(source)) return;
                loss.sources.add(source);
            }
            loss.count++;
        },
        warnings: () => [...losses].map(([code, { count }]) => ({ code, count })),
    };
}

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

// The route's preview less the mode it adds: a doc's carries its page and its Normal, which quick look and the hero
// draw it on and in.
export type PreviewResult = Omit<TextPreviewResult, 'mode'>;
// Body text for the content index, already capped by the extractor — small like a
// preview body.
export type ExtractTextResult = { text: string };
// `zoom` is the one htmlToPdf hands WeasyPrint for a PDF document laid out at 1:1: a deck's, from its width.
export type ExportTransformResult = { data: ArrayBuffer; zoom?: number };
// UTF-8 bytes of the lean Sheet[] JSON — the main thread commits the string
// without parsing it — plus the pictures its images name, which it writes through Mount.
export type SheetsImportTransformResult = { snapshotJson: ArrayBuffer; images: TransformMedia[] };
// A ready Yjs update plus the images extracted from the docx, its page and its Normal: the main thread
// only commits the update, the page and the Normal and writes the media through Mount.
export type DocImportTransformResult = {
    update: ArrayBuffer;
    page: PageSetup;
    style: NormalStyle;
    images: TransformMedia[];
};
// The same with the warnings the reader counted, which the import's summary phrases.
export type DocImportResult = DocImportTransformResult & { warnings: TransformWarning[] };
// A pptx's update plus its pictures: the main thread only applies the update and writes the media through Mount.
export type SlidesImportTransformResult = { update: ArrayBuffer; images: TransformMedia[] };

export type TransformResult =
    | PreviewResult
    | ExtractTextResult
    | ExportTransformResult
    | SheetsImportTransformResult
    | DocImportTransformResult
    | SlidesImportTransformResult;

// Which result a job kind produces. The runner proves the pairing at runtime with
// resultMatchesRequest; run-transform.ts narrows to this once so no caller re-checks.
// Keyed off the job discriminants, so a captured request (job + source) resolves the
// same. A future arm resolves to `never` and fails to compile at its callsite.
export type TransformResultFor<R extends CollabTransformJob | BytesTransformJob> = R extends { kind: 'preview' }
    ? PreviewResult
    : R extends { kind: 'extract-text' }
      ? ExtractTextResult
      : R extends { kind: 'export' }
        ? ExportTransformResult
        : R extends { targetType: 'eigensheets' }
          ? SheetsImportTransformResult
          : R extends { targetType: 'eigendoc' }
            ? DocImportTransformResult
            : R extends { targetType: 'eigenslides' }
              ? SlidesImportTransformResult
              : never;

export type DocumentTransformResponse =
    | { ok: true; result: TransformResult; warnings: TransformWarning[] }
    | { ok: false; error: TransformError };

export type ChildRequestEnvelope = { jobId: number; request: DocumentTransformRequest };
// The child's first message: the job arrived, so a death from here on is the job's.
export type ChildAck = { jobId: number; ack: true };
// An export's child asks for the media its document names; the runner answers with them prepared.
export type ChildMediaRequest = { jobId: number; mediaNames: string[] };
export type ParentMediaReply = { jobId: number; media: ExportMedia[] };
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
              zoom?: unknown;
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
            return (
                r?.data instanceof ArrayBuffer &&
                (r.zoom === undefined || (typeof r.zoom === 'number' && Number.isFinite(r.zoom) && r.zoom > 0))
            );
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
                    return (
                        r?.snapshotJson instanceof ArrayBuffer &&
                        Array.isArray(r.images) &&
                        r.images.every(isTransformMedia)
                    );
            }
    }
}

export function resultBytes(result: TransformResult): number {
    if ('body' in result) return Buffer.byteLength(result.body);
    if ('text' in result) return Buffer.byteLength(result.text);
    if ('data' in result) return result.data.byteLength;
    const main = 'snapshotJson' in result ? result.snapshotJson : result.update;
    return result.images.reduce((sum, image) => sum + image.data.byteLength, main.byteLength);
}

// Buffers from TextEncoder and the writers can be views over a larger pool, and IPC
// serializes a view's WHOLE backing buffer — copy to an exact standalone one first.
export function toTransferableBuffer(bytes: Uint8Array): ArrayBuffer {
    const { buffer } = bytes;
    if (buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength)
        return buffer;
    const out = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(out).set(bytes);
    return out;
}

// An import's media files as they cross back.
export function toTransferableMedia(
    media: { name: string; contentType: string; data: Uint8Array }[],
): TransformMedia[] {
    return media.map(({ name, contentType, data }) => ({ name, contentType, data: toTransferableBuffer(data) }));
}

// Every text result (export documents, the import snapshot JSON) crosses as UTF-8
// bytes the main thread decodes or serves as-is.
export function toTransferableText(text: string): ArrayBuffer {
    return toTransferableBuffer(new TextEncoder().encode(text));
}
