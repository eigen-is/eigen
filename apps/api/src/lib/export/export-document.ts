import { DRIVE_MIME_DOC, DRIVE_MIME_SHEETS, DRIVE_MIME_SLIDES, DRIVE_MIME_VECTOR } from '@workspace/lib/types';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import { ApiError } from '../core/errors';
import type {
    DocumentExportFormat,
    EigendocExportFormat,
    SheetExportFormat,
    VectorExportFormat,
} from '../document/transform/protocol';
import { runTransformToBytes } from '../document/transform/run-transform';
import { documentTransformRunner } from '../document/transform/runner';
import type { Mount } from '../mount';
import { collectExportMedia } from './media';
import { htmlToPdf } from './weasyprint';

export type ExportResult = {
    data: Buffer;
    contentType: string;
    fileName: string;
};

// One envelope per download format: the document the Worker renders, the headers the
// route serves, and the filename extension (always over the stripped container name).
// `pdf` is the only format with a main-thread stage left.
const EXPORT_ENVELOPES = {
    html: { workerFormat: 'html', contentType: 'text/html; charset=utf-8', extension: 'html' },
    pdf: { workerFormat: 'pdf-html', contentType: 'application/pdf', extension: 'pdf' },
    svg: { workerFormat: 'svg', contentType: 'image/svg+xml', extension: 'svg' },
    xlsx: {
        workerFormat: 'xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extension: 'xlsx',
    },
    docx: {
        workerFormat: 'docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extension: 'docx',
    },
} as const;

type ExportEnvelope = (typeof EXPORT_ENVELOPES)[keyof typeof EXPORT_ENVELOPES];

// What the Worker is asked to render. One arm per document type, so a format its route
// rejects — a docx from a deck, an xlsx from a document — does not compile.
export type ExportJob =
    | { documentType: 'eigensheets'; format: SheetExportFormat }
    | { documentType: 'eigendoc'; format: EigendocExportFormat }
    | { documentType: 'eigenslides'; format: DocumentExportFormat }
    | { documentType: 'eigenvector'; format: VectorExportFormat };

// `signal` aborts the off-thread transforms when the client disconnects — the runner
// drops the queued job or terminates its Worker.
export async function exportDocument(
    mount: Mount,
    path: DrivePath,
    format: string,
    signal?: AbortSignal,
): Promise<ExportResult> {
    if (path.mimeType === DRIVE_MIME_DOC && (format === 'html' || format === 'pdf' || format === 'docx')) {
        const envelope = EXPORT_ENVELOPES[format];
        return serveExport({ documentType: 'eigendoc', format: envelope.workerFormat }, envelope, mount, path, signal);
    }
    if (path.mimeType === DRIVE_MIME_SHEETS && (format === 'html' || format === 'pdf' || format === 'xlsx')) {
        const envelope = EXPORT_ENVELOPES[format];
        return serveExport(
            { documentType: 'eigensheets', format: envelope.workerFormat },
            envelope,
            mount,
            path,
            signal,
        );
    }
    if (path.mimeType === DRIVE_MIME_SLIDES && (format === 'html' || format === 'pdf')) {
        const envelope = EXPORT_ENVELOPES[format];
        return serveExport(
            { documentType: 'eigenslides', format: envelope.workerFormat },
            envelope,
            mount,
            path,
            signal,
        );
    }
    if (path.mimeType === DRIVE_MIME_VECTOR && (format === 'svg' || format === 'pdf')) {
        const envelope = EXPORT_ENVELOPES[format];
        return serveExport(
            { documentType: 'eigenvector', format: envelope.workerFormat },
            envelope,
            mount,
            path,
            signal,
        );
    }
    throw new ApiError(400, `Format "${format}" is not supported for ${path.mimeType}`);
}

async function serveExport(
    job: ExportJob,
    envelope: ExportEnvelope,
    mount: Mount,
    path: DrivePath,
    signal?: AbortSignal,
): Promise<ExportResult> {
    const bytes = await runDocumentExport(job, mount, path, signal);
    return {
        // WeasyPrint stays a main-thread subprocess (already off-process, so it never
        // blocks the event loop) over the document the Worker rendered.
        data: envelope.workerFormat === 'pdf-html' ? await htmlToPdf(bytes) : bytes,
        contentType: envelope.contentType,
        fileName: `${stripEigenExtension(path.name)}.${envelope.extension}`,
    };
}

// The one main-thread entry every export takes: prepare what the Worker cannot fetch,
// then run the shared transform seam. The Worker returns the finished bytes — the UTF-8
// document for html and pdf-html, the zip for xlsx and docx.
export async function runDocumentExport(
    job: ExportJob,
    mount: Mount,
    path: DrivePath,
    signal?: AbortSignal,
): Promise<Buffer> {
    // Sheets embed no media. Doc and slides do, and the Mount I/O plus the screen
    // previews behind it stay on this thread.
    if (job.documentType === 'eigensheets') {
        const title = stripEigenExtension(path.name);
        return runTransformToBytes(mount, path, { kind: 'export', ...job, title }, { signal });
    }

    // Refuse before the prep: media collection is Mount I/O plus a screen preview per
    // image, and a job the runner will not admit must not pay for it. run() rechecks
    // authoritatively — this is only the early exit.
    documentTransformRunner.assertAdmissible('foreground');

    const prepStart = performance.now();
    const media = await collectExportMedia(mount, path);
    const prepMs = performance.now() - prepStart;
    // The eigendoc <title> keeps the UNstripped container name (frozen output); the
    // docx document property carries the stripped one, applied in the Worker.
    const title = job.documentType === 'eigendoc' ? path.name : stripEigenExtension(path.name);
    return runTransformToBytes(mount, path, { kind: 'export', ...job, title, media }, { prepMs, signal });
}
