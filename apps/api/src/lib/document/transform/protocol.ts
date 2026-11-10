// The closed request and response unions that cross into the document-transform process, such as a preview, an export,
// an import or a search extract, and the helpers both sides share. Only serializable values ride here: primitives,
// ArrayBuffers and Maps of primitives, never a Mount, a database, a Y.Doc or another class instance, and never a module
// or function name user input could influence.

import type { NormalStyle, PageSetup } from '@workspace/lib/docs/eigendoc';
import type { DriveCollabType, ImageDimensions } from '@workspace/lib/types/drive';
import type { TextPreviewResult } from '@workspace/lib/types/preview';
import type { SlidePage } from '@workspace/lib/vector';
import type { YjsStatePayload } from '../../collab/yjs-loader';
import { ApiError, isOutOfMemory } from '../../core/errors';
import type { DocumentReferences } from '../references';

// `pdf-html` is the HTML stage of the PDF export. WeasyPrint stays a subprocess of the main thread, so the
// transform returns the document it renders from.
export type SheetExportFormat = 'html' | 'xlsx' | 'pdf-html';
export type DocumentExportFormat = 'html' | 'pdf-html';
// Only eigendoc exports to docx and only eigenslides to pptx; the other routes reject them.
export type EigendocExportFormat = DocumentExportFormat | 'docx';
export type SlidesExportFormat = DocumentExportFormat | 'pptx';
// A drawing exports as one page WeasyPrint renders to PDF; its SVG is the editor's own (packages/ui's canvas image).
export type VectorExportFormat = 'pdf-html';

// What an HTML export is for: the download a browser opens, or the document WeasyPrint prints.
export type HtmlExportMode = 'screen' | 'pdf';

// Out of the module of exportHtmlDocument, which loads jsdom, so an xlsx export never evaluates it.
export function htmlExportMode(format: DocumentExportFormat): HtmlExportMode {
    return format === 'pdf-html' ? 'pdf' : 'screen';
}

// Document media crossing the boundary: prepared on the main thread for an export
// (Mount I/O and a re-encode from the source), extracted from the upload by an import.
export type TransformMedia = { name: string; contentType: string; data: ArrayBuffer };

// An export's media. A raster made from its source carries the size of the picture as sent, and the cached preview an
// HTML download takes carries none, nor does an SVG, which the writers measure themselves.
export type ExportMedia = TransformMedia & Partial<ImageDimensions>;

// An export's renderer asks for the media its document names once it has read the document, so the main thread
// prepares only those, while the job holds its slot.
export type ExportMediaLoader = (names: Set<string>) => Promise<ExportMedia[]>;

// A job is what a caller decides, and the capture of its source completes it into a request. A preview references its
// media by URL, so no media bytes cross for it.
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

// `title` is the document title the renderer embeds, because the transform has no DrivePath. Sheets and slides
// strip the eigen extension from it. An eigendoc's <title> keeps the full container name, a frozen output.
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

// A conversion of uploaded bytes, which learns of its destination only what an insert fits into. There is one arm per
// source format, so an impossible pairing, such as xlsx into an eigendoc, does not compile.
export type SheetsImportJob = {
    kind: 'import';
    sourceFormat: 'xlsx';
    targetType: 'eigensheets';
    // The upload cap, which bounds the pictures' inflated bytes too; the transform reads no config.
    maxMediaBytes: number;
    // The open workbook an inserting Import… adds the file's tabs to. A Convert and a replace pass none.
    workbook?: SheetsWorkbookJson;
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

// A workbook read from the live doc: its snapshot and op batches as JSON text, which crosses to the child much faster
// than objects.
export type SheetsWorkbookJson = { snapshot: string | null; batches: string };

// A workbook's op log folded into its snapshot when the document closes.
export type SheetsCompactionJob = { kind: 'compact'; documentType: 'eigensheets' } & SheetsWorkbookJson;

// The parts one document's state names.
export type ReferencesJob = { kind: 'references'; documentType: DriveCollabType; source: YjsStatePayload };

export type DocumentTransformRequest =
    | (CollabTransformJob & { source: YjsStatePayload })
    | (BytesTransformJob & { data: ArrayBuffer })
    | SheetsCompactionJob
    | ReferencesJob;

// The warnings that count what a read skipped, an import left out or an export cut.
export const COUNTED_WARNING_CODES = [
    'corrupt-blobs-skipped',
    'blocks-flattened',
    'images-unshown',
    'images-dropped',
    'mirrors-dropped',
    'crops-dropped',
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

// `status` carries the HTTP status of a controlled document error, as no Error instance crosses. `out-of-memory`: the
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
// Body text for the content index. The extractor already capped it, so it is as small as a preview body.
export type ExtractTextResult = { text: string };
// `zoom` is the one htmlToPdf hands WeasyPrint for a PDF document laid out at 1:1: a deck's, from its width.
export type ExportTransformResult = { data: ArrayBuffer; zoom?: number };
// A workbook's stored cells and the characters of their text, as sheetsWeight counts them.
export type SheetsWeight = { cells: number; text: number };
// The lean Sheet[] JSON as UTF-8 bytes, which the main thread commits without parsing it, and the pictures it names.
// The weight is what an insert adds to the open workbook's before it builds its batch, still in the transform.
export type SheetsImportTransformResult = { snapshotJson: ArrayBuffer; weight: SheetsWeight; images: TransformMedia[] };
// An insert's one batch of addSheet ops as JSON in UTF-8 bytes, which the main thread pushes onto the log, and the
// pictures its sheets name.
export type SheetsInsertTransformResult = { batch: ArrayBuffer; images: TransformMedia[] };
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
// The compacted snapshot's JSON as UTF-8 bytes, how many op batches the replay dropped because they failed to apply,
// and how many of the log's first batches it folded.
export type SheetsCompactionResult = { snapshot: ArrayBuffer; dropped: number; folded: number };
// The media files and comment threads the job's document names.
export type ReferencesResult = { references: DocumentReferences };

export type TransformResult =
    | PreviewResult
    | ExtractTextResult
    | ExportTransformResult
    | SheetsImportTransformResult
    | SheetsInsertTransformResult
    | DocImportTransformResult
    | SlidesImportTransformResult
    | SheetsCompactionResult
    | ReferencesResult;

// Which result a job kind produces, keyed off the job discriminants, so a captured request (job + source) resolves the
// same. A future arm resolves to `never` and fails to compile at its callsite.
export type TransformResultFor<R extends CollabTransformJob | BytesTransformJob | SheetsCompactionJob | ReferencesJob> =
    R extends { kind: 'preview' }
        ? PreviewResult
        : R extends { kind: 'extract-text' }
          ? ExtractTextResult
          : R extends { kind: 'export' }
            ? ExportTransformResult
            : R extends { kind: 'compact' }
              ? SheetsCompactionResult
              : R extends { kind: 'references' }
                ? ReferencesResult
                : R extends { workbook: SheetsWorkbookJson }
                  ? SheetsInsertTransformResult
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
    if ('data' in request) {
        const workbook = 'workbook' in request ? request.workbook : undefined;
        return request.data.byteLength + (workbook ? workbookBytes(workbook) : 0);
    }
    if (request.kind === 'compact') return workbookBytes(request);
    let bytes = request.source.snapshot?.data.byteLength ?? 0;
    for (const update of request.source.updates) bytes += update.data.byteLength;
    return bytes;
}

function workbookBytes({ snapshot, batches }: SheetsWorkbookJson): number {
    return Buffer.byteLength(snapshot ?? '') + Buffer.byteLength(batches);
}

export function resultBytes(result: TransformResult): number {
    if ('body' in result) return Buffer.byteLength(result.body);
    if ('text' in result) return Buffer.byteLength(result.text);
    if ('data' in result) return result.data.byteLength;
    if ('snapshot' in result) return result.snapshot.byteLength;
    if ('references' in result) return Buffer.byteLength(JSON.stringify(result.references));
    const main = 'snapshotJson' in result ? result.snapshotJson : 'batch' in result ? result.batch : result.update;
    return result.images.reduce((sum, image) => sum + image.data.byteLength, main.byteLength);
}

// A buffer from TextEncoder or a writer can be a view over a larger pool. IPC sends a view's whole backing buffer,
// so the bytes are copied to an exact buffer of their own first.
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

// Every text result (export documents, the import and compaction snapshot JSON) crosses as UTF-8
// bytes the main thread decodes or serves as-is.
export function toTransferableText(text: string): ArrayBuffer {
    return toTransferableBuffer(new TextEncoder().encode(text));
}
