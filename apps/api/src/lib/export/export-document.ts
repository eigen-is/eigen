// An export's main-thread entry, which the export route calls: the container's type and the format pick the job, the
// transform process renders it, and a PDF is that document through WeasyPrint. The media the document names is
// prepared here, beside the Mount, and what the writer left out comes back as a summary for the user.

import { DOCX_MIME, PPTX_MIME, XLSX_MIME } from '@workspace/lib/constants/mime';
import { DRIVE_MIME_DOC, DRIVE_MIME_SHEETS, DRIVE_MIME_SLIDES, DRIVE_MIME_VECTOR } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { EIGEN_DOC_TYPE_INFO, isCollabType, stripEigenExtension } from '@workspace/lib/types/drive';
import { getPublicOrigin } from '../config/server-config';
import { ApiError } from '../core/errors';
import { lossSummary } from '../document/transform/losses';
import type {
    EigendocExportFormat,
    ExportTransformJob,
    SheetExportFormat,
    SlidesExportFormat,
    TransformWarning,
    VectorExportFormat,
} from '../document/transform/protocol';
import { runTransformToBytes } from '../document/transform/run-transform';
import type { Mount } from '../mount';
import { collectExportMedia } from './media';
import { htmlToPdf } from './weasyprint';

// `summary` says what the file left out, for the toast after a download or a print, or is null.
type ExportResult = {
    data: Buffer;
    contentType: string;
    fileName: string;
    summary: string | null;
};

// One envelope per download format: the document the transform process renders, the headers the
// route serves, and the filename extension (always over the stripped container name).
// `pdf` is the only format with a main-thread stage left.
const EXPORT_ENVELOPES = {
    html: { transformFormat: 'html', contentType: 'text/html; charset=utf-8', extension: 'html' },
    pdf: { transformFormat: 'pdf-html', contentType: 'application/pdf', extension: 'pdf' },
    xlsx: { transformFormat: 'xlsx', contentType: XLSX_MIME, extension: 'xlsx' },
    docx: { transformFormat: 'docx', contentType: DOCX_MIME, extension: 'docx' },
    pptx: { transformFormat: 'pptx', contentType: PPTX_MIME, extension: 'pptx' },
} as const;

type ExportEnvelope = (typeof EXPORT_ENVELOPES)[keyof typeof EXPORT_ENVELOPES];

// What the transform process is asked to render. One arm per document type, so a format its route
// rejects — a docx from a deck, a pptx from a document — does not compile.
type ExportJob =
    | { documentType: 'eigensheets'; format: SheetExportFormat }
    | { documentType: 'eigendoc'; format: EigendocExportFormat }
    | { documentType: 'eigenslides'; format: SlidesExportFormat }
    | { documentType: 'eigenvector'; format: VectorExportFormat };

// `signal` aborts the transform when the client disconnects: the runner drops the queued job
// or kills its child process.
export async function exportDocument(
    mount: Mount,
    path: DrivePath,
    format: string,
    signal?: AbortSignal,
): Promise<ExportResult> {
    // The container TYPE gates the dispatch: mimeType is caller-controlled on upload, so a plain
    // file wearing an eigen mime falls through to the 400 rather than into a render with no data.db.
    const containerMime = isCollabType(path.type) ? path.mimeType : '';
    if (containerMime === DRIVE_MIME_DOC && offers(EIGEN_DOC_TYPE_INFO.doc.exportFormats, format)) {
        const envelope = EXPORT_ENVELOPES[format];
        return serveExport(
            { documentType: 'eigendoc', format: envelope.transformFormat },
            envelope,
            mount,
            path,
            signal,
        );
    }
    if (containerMime === DRIVE_MIME_SHEETS && offers(EIGEN_DOC_TYPE_INFO.sheets.exportFormats, format)) {
        const envelope = EXPORT_ENVELOPES[format];
        return serveExport(
            { documentType: 'eigensheets', format: envelope.transformFormat },
            envelope,
            mount,
            path,
            signal,
        );
    }
    if (containerMime === DRIVE_MIME_SLIDES && offers(EIGEN_DOC_TYPE_INFO.slides.exportFormats, format)) {
        const envelope = EXPORT_ENVELOPES[format];
        return serveExport(
            { documentType: 'eigenslides', format: envelope.transformFormat },
            envelope,
            mount,
            path,
            signal,
        );
    }
    if (containerMime === DRIVE_MIME_VECTOR && offers(EIGEN_DOC_TYPE_INFO.vector.exportFormats, format)) {
        const envelope = EXPORT_ENVELOPES[format];
        return serveExport(
            { documentType: 'eigenvector', format: envelope.transformFormat },
            envelope,
            mount,
            path,
            signal,
        );
    }
    throw new ApiError(400, `Format "${format}" is not supported for ${path.mimeType}`);
}

// The gate AND the narrowing: the type's own list is what the Download menus offer, and each entry
// narrows to a literal, so a format added there without an envelope for it fails to compile.
function offers<T extends readonly string[]>(formats: T, format: string): format is T[number] {
    return formats.includes(format);
}

async function serveExport(
    job: ExportJob,
    envelope: ExportEnvelope,
    mount: Mount,
    path: DrivePath,
    signal?: AbortSignal,
): Promise<ExportResult> {
    // A deck's PDF document lays its slides out at 1:1 (renderPrintPage), so WeasyPrint's zoom scales them
    // onto the sheet.
    const { data: bytes, zoom, warnings } = await runDocumentExport(job, mount, path, signal);
    return {
        // WeasyPrint runs in a subprocess of its own, so it never blocks the event loop, over the
        // document the transform process rendered.
        data: envelope.transformFormat === 'pdf-html' ? await htmlToPdf(bytes, zoom, signal) : bytes,
        contentType: envelope.contentType,
        fileName: `${stripEigenExtension(path.name)}.${envelope.extension}`,
        summary: lossSummary(warnings, 'export'),
    };
}

// The one main-thread entry every export takes: run the shared transform seam, and prepare
// the media the child names once it has read the document. The child returns the finished
// bytes, the UTF-8 document for html and pdf-html or the zip for xlsx, docx and pptx, and a
// deck's pdf-html the zoom WeasyPrint prints it at, with the warnings that count what it left out.
export async function runDocumentExport(
    job: ExportJob,
    mount: Mount,
    path: DrivePath,
    signal?: AbortSignal,
): Promise<{ data: Buffer; zoom?: number; warnings: TransformWarning[] }> {
    // The eigendoc <title> keeps the UNstripped container name (frozen output); the
    // docx document property carries the stripped one, applied in the child. Root-relative
    // links take the public origin in every format, none on a checkout's dev server.
    const request: ExportTransformJob =
        job.documentType === 'eigendoc'
            ? { kind: 'export', ...job, title: path.name, publicOrigin: getPublicOrigin() }
            : { kind: 'export', ...job, title: stripEigenExtension(path.name) };
    return runTransformToBytes(mount, path, request, {
        signal,
        prepareMedia: (names, prepSignal) => collectExportMedia(mount, path, job.format, names, prepSignal),
    });
}
