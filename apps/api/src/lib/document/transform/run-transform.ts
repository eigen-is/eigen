// The one main-thread path every document transform takes. It admits the job, logs its warnings and maps its failures,
// and for a job that reads a stored document it captures the compressed Yjs blobs first. A caller adds only its job
// fields and what it does with the result. There is no main-thread fallback. A runner 503 and a controlled document
// error keep their status. An import out of memory is a file too large, and so is an export or a search extract that
// ran out of memory or time. Any other failure throws.

import { readSheetsSnapshotJson, sheetsOpLog } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import type * as Y from 'yjs';
import type { YjsStatePayload } from '../../collab/yjs-loader';
import { ApiError } from '../../core/errors';
import { IMPORT_MESSAGES } from '../../import/messages';
import type { Mount } from '../../mount';
import type { DocumentReferences } from '../references';
import { captureCollabSource } from './collab-source';
import type {
    BytesPreviewJob,
    CollabPreviewJob,
    DocImportJob,
    DocImportResult,
    DocumentTransformRequest,
    ExportTransformJob,
    ExtractTextJob,
    PreviewResult,
    ReferencesJob,
    SheetsImportJob,
    SheetsWeight,
    SlidesImportJob,
    SlidesImportTransformResult,
    TransformError,
    TransformMedia,
    TransformResultFor,
    TransformWarning,
} from './protocol';
import type { RunOptions, TransformPriority } from './runner';
import { documentTransformRunner, TRANSFORM_LIMITS } from './runner';

// What a caller still decides, since the limits belong to the job kind and the capture is timed here. `prepMs` is the
// time the caller spent preparing media on the main thread, which the job's log line shows.
type TransformOptions = Omit<RunOptions, 'priority' | 'deadlineMs' | 'admissionCostMs' | 'captureMs'> & {
    priority?: TransformPriority;
};

const TOO_LARGE_TO_INDEX = 'Document too large to index';
export const TOO_LARGE_TO_EXPORT = 'Export failed: the document is too big, or it used too much memory';

// The failures the same input repeats: a job past its memory or its deadline. A crash may be the install, not the input.
function repeatsForSameInput(code: TransformError['code']): boolean {
    return code === 'out-of-memory' || code === 'timeout';
}

// Every other failure, with its code and whether the same input would fail again, so a caller can stop rerunning it.
export class TransformFailedError extends Error {
    public readonly code: TransformError['code'];
    public readonly repeats: boolean;

    public constructor(code: TransformError['code'], message: string) {
        super(message);
        this.code = code;
        this.repeats = repeatsForSameInput(code);
    }
}

async function runTransformRequest<R extends DocumentTransformRequest>(
    request: R,
    opts: TransformOptions & { captureMs?: number },
): Promise<{ result: TransformResultFor<R>; warnings: TransformWarning[] }> {
    const { priority = 'foreground', ...rest } = opts;
    const limits = TRANSFORM_LIMITS[request.kind];
    // The caller's preparation counts against the deadline, so a job has one deadline end to end. A job whose
    // preparation spent it all times out at once.
    const response = await documentTransformRunner.run(request, {
        ...rest,
        ...limits,
        deadlineMs: limits.deadlineMs - (rest.prepMs ?? 0),
        priority,
    });
    if (!response.ok) {
        if (response.error.status) throw new ApiError(response.error.status, response.error.message);
        if (response.error.code === 'out-of-memory' && request.kind === 'import') {
            throw new ApiError(413, IMPORT_MESSAGES[request.sourceFormat].tooLarge);
        }
        if (repeatsForSameInput(response.error.code)) {
            // The search extract indexes it as nothing rather than running out, or timing out, again on every drain.
            if (request.kind === 'extract-text') throw new ApiError(413, TOO_LARGE_TO_INDEX);
            if (request.kind === 'export') throw new ApiError(413, TOO_LARGE_TO_EXPORT);
        }
        const what =
            request.kind === 'import' ? `${request.sourceFormat} import` : `${request.documentType} ${request.kind}`;
        throw new TransformFailedError(
            response.error.code,
            `${what} transform failed (${response.error.code}): ${response.error.message}`,
        );
    }
    for (const warning of response.warnings) surfaceWarning(warning, request.kind);
    // The runner settles every kind of job through one wide response, and the child answers each kind with its own
    // result. This cast is the one place that mapping is crossed, so every caller reads its field with no cast.
    return { result: response.result as TransformResultFor<R>, warnings: response.warnings };
}

// `toRequest` completes the caller's own job with the captured source. The request keeps its kind, so the result
// narrows with it.
async function runDocumentTransform<R extends DocumentTransformRequest>(
    mount: Mount,
    drivePath: DrivePath,
    opts: TransformOptions,
    toRequest: (source: YjsStatePayload) => R,
): Promise<{ result: TransformResultFor<R>; warnings: TransformWarning[] }> {
    // A job the runner won't admit is refused before the capture, so it never pays for a full read of the blobs.
    const priority = opts.priority ?? 'foreground';
    documentTransformRunner.assertAdmissible(priority);

    const captureStart = performance.now();
    const source = await captureCollabSource(mount, drivePath);
    return runTransformRequest(toRequest(source), {
        ...opts,
        priority,
        captureMs: performance.now() - captureStart,
    });
}

// Only a failed recalc is logged here. The child already logs every skipped blob, and the runner logs each warning
// code with the job. After a failed recalc, a read serves the replayed values and an import keeps the parsed ones.
function surfaceWarning(warning: TransformWarning, kind: DocumentTransformRequest['kind']): void {
    if (warning.code !== 'recalc-failed') return;
    if (kind === 'import') {
        console.warn('[import] server recalc of imported sheets failed, persisting parsed values:', warning.message);
    } else {
        console.warn('[sheets] server recalc failed, serving replayed values:', warning.message);
    }
}

// These return a job's text, such as a preview body or the text to index, or its bytes, such as an export. An export
// keeps its warnings, for the summary it answers with.
export async function runTransformToPreview(
    mount: Mount,
    drivePath: DrivePath,
    job: CollabPreviewJob,
    opts: TransformOptions,
): Promise<PreviewResult> {
    const { result } = await runDocumentTransform(mount, drivePath, opts, (source) => ({ ...job, source }));
    return result;
}

export async function runTransformToExtractedText(
    mount: Mount,
    drivePath: DrivePath,
    job: ExtractTextJob,
    opts: TransformOptions,
): Promise<string> {
    const { result } = await runDocumentTransform(mount, drivePath, opts, (source) => ({ ...job, source }));
    return result.text;
}

export async function runTransformToBytes(
    mount: Mount,
    drivePath: DrivePath,
    job: ExportTransformJob,
    opts: TransformOptions,
): Promise<{ data: Buffer; zoom?: number; warnings: TransformWarning[] }> {
    const { result, warnings } = await runDocumentTransform(mount, drivePath, opts, (source) => ({ ...job, source }));
    return { data: Buffer.from(result.data), zoom: result.zoom, warnings };
}

// Like runDocumentTransform, but the input is the file itself, read from the Mount after admission. It returns null
// when the file is gone, so the caller serves no preview rather than an empty one.
export async function runFileTransformToText(
    mount: Mount,
    drivePath: DrivePath,
    job: BytesPreviewJob,
    opts: TransformOptions,
): Promise<string | null> {
    const priority = opts.priority ?? 'foreground';
    documentTransformRunner.assertAdmissible(priority);

    const captureStart = performance.now();
    const bytes = await mount.readBytes(drivePath.id);
    if (!bytes) return null;

    return runBytesTransformToText(job, bytes, {
        ...opts,
        priority,
        captureMs: performance.now() - captureStart,
    });
}

// The same job with the bytes already in hand, for a mail part, which has no Mount to read them from.
export async function runBytesTransformToText(
    job: BytesPreviewJob,
    data: ArrayBuffer,
    opts: TransformOptions & { captureMs?: number },
): Promise<string> {
    const { result } = await runTransformRequest({ ...job, data }, opts);
    return result.body;
}

// An import returns what the caller commits, the media it extracted and its warnings. A workbook comes back as snapshot
// JSON the main thread never parses, and a document or a deck as a ready Yjs update.
export type SheetsImportSnapshot = {
    snapshotJson: string;
    weight: SheetsWeight;
    images: TransformMedia[];
    warnings: TransformWarning[];
};

export async function runImportToSnapshotJson(
    job: SheetsImportJob,
    data: ArrayBuffer,
    opts: TransformOptions,
): Promise<SheetsImportSnapshot> {
    const { result, warnings } = await runTransformRequest({ ...job, data }, opts);
    const snapshotJson = new TextDecoder().decode(result.snapshotJson);
    return { snapshotJson, weight: result.weight, images: result.images, warnings };
}

export async function runImportToDocumentUpdate(
    job: DocImportJob,
    data: ArrayBuffer,
    opts: TransformOptions,
): Promise<DocImportResult> {
    const { result, warnings } = await runTransformRequest({ ...job, data }, opts);
    return { ...result, warnings };
}

export async function runImportToSlidesUpdate(
    job: SlidesImportJob,
    data: ArrayBuffer,
    opts: TransformOptions,
): Promise<SlidesImportTransformResult & { warnings: TransformWarning[] }> {
    const { result, warnings } = await runTransformRequest({ ...job, data }, opts);
    return { ...result, warnings };
}

// A workbook's op log folded into its snapshot, read from the live doc in one step, as data.db can lag behind. The
// signal ends the job queued or running, so the caller bounds the whole wait with it.
export async function runSheetsCompaction(
    doc: Y.Doc,
    signal: AbortSignal,
): Promise<{ snapshot: string; dropped: number }> {
    const snapshot = readSheetsSnapshotJson(doc) ?? null;
    const batches = JSON.stringify(sheetsOpLog(doc).toArray());
    const { result } = await runTransformRequest(
        { kind: 'compact', documentType: 'eigensheets', snapshot, batches },
        { priority: 'background', signal },
    );
    return { snapshot: new TextDecoder().decode(result.snapshot), dropped: result.dropped };
}

// The parts one document's state names.
export async function runDocumentReferences(
    document: Omit<ReferencesJob, 'kind'>,
    opts: TransformOptions,
): Promise<DocumentReferences> {
    const { result } = await runTransformRequest({ kind: 'references', ...document }, opts);
    return result.references;
}
