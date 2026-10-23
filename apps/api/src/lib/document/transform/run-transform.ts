import type { DrivePath } from '@workspace/lib/types/drive';
import type { YjsStatePayload } from '../../collab/yjs-loader';
import { ApiError } from '../../core/errors';
import { IMPORT_MESSAGES } from '../../import/messages';
import type { Mount } from '../../mount';
import { captureCollabSource } from './collab-source';
import type {
    BytesPreviewJob,
    CollabPreviewJob,
    DocImportJob,
    DocImportWorkerResult,
    DocumentTransformRequest,
    ExportTransformJob,
    ExtractTextJob,
    PreviewResult,
    SheetsImportJob,
    SlidesImportJob,
    SlidesImportWorkerResult,
    TransformError,
    TransformMedia,
    TransformResultFor,
    TransformWarning,
} from './protocol';
import { documentTransformRunner, type RunOptions, TRANSFORM_LIMITS, type TransformPriority } from './runner';

// The one main-thread path every document transform takes: admit the job, surface
// warnings, map failures — plus, for document-sourced jobs, the capture of the
// compressed Yjs blobs. A caller adds only its job fields and what it does with
// the result, so a new operation (doc/slides preview, HTML/PDF/DOCX export, DOCX
// import) is a thin wrapper plus a pure converter in the transform process — no new
// orchestration.
//
// There is deliberately no main-thread fallback: a runner 503 and controlled
// document errors keep their HTTP status, an import or a search extract that ran out of
// memory is a file too large, as is a search extract that timed out, every other failure throws.

// What a caller still decides; the limits belong to the job kind (TRANSFORM_LIMITS),
// and the capture time is measured here. prepMs: main-thread media preparation time,
// measured by the caller's wrapper — logged with the job so a fast transform behind slow
// preparation stays visible.
type TransformOptions = Omit<RunOptions, 'priority' | 'deadlineMs' | 'admissionCostMs' | 'captureMs'> & {
    priority?: TransformPriority;
};

const TOO_LARGE_TO_INDEX = 'Document too large to index';

// The failures the same input repeats: a job past its memory or its deadline. A crash may be the install, not the input.
function repeatsForSameInput(code: TransformError['code']): boolean {
    return code === 'out-of-memory' || code === 'timeout';
}

// Every other failure, with whether the same input would fail again, so a caller can stop rerunning it.
export class TransformFailedError extends Error {
    readonly repeats: boolean;

    constructor(code: TransformError['code'], message: string) {
        super(message);
        this.repeats = repeatsForSameInput(code);
    }
}

async function runTransformRequest<R extends DocumentTransformRequest>(
    request: R,
    opts: TransformOptions & { captureMs?: number },
): Promise<{ result: TransformResultFor<R>; warnings: TransformWarning[] }> {
    const { priority = 'foreground', ...rest } = opts;
    const limits = TRANSFORM_LIMITS[request.kind];
    // The caller's prep spends from the deadline, so a job is one deadline end to end; a spent one times out at once.
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
        // The search extract indexes it as nothing rather than running out, or timing out, again on every drain.
        if (repeatsForSameInput(response.error.code) && request.kind === 'extract-text') {
            throw new ApiError(413, TOO_LARGE_TO_INDEX);
        }
        const what =
            request.kind === 'import' ? `${request.sourceFormat} import` : `${request.documentType} ${request.kind}`;
        throw new TransformFailedError(
            response.error.code,
            `${what} transform failed (${response.error.code}): ${response.error.message}`,
        );
    }
    for (const warning of response.warnings) surfaceWarning(warning, request.kind);
    // The one seam the kind→result mapping crosses: the runner settles every kind of job
    // through one widened response, having already proved this result pairs with this
    // request (resultMatchesRequest). Past here every caller reads its field with no cast.
    return { result: response.result as TransformResultFor<R>, warnings: response.warnings };
}

// `toRequest` completes the caller's own job with the captured source, so the request
// keeps its kind here and the result narrows with it.
async function runDocumentTransform<R extends DocumentTransformRequest>(
    mount: Mount,
    drivePath: DrivePath,
    opts: TransformOptions,
    toRequest: (source: YjsStatePayload) => R,
): Promise<TransformResultFor<R>> {
    // Refuse before the capture: a job the runner will not admit must not pay for a
    // full read of the document's blobs (a refused reindex drain did, per row).
    const priority = opts.priority ?? 'foreground';
    documentTransformRunner.assertAdmissible(priority);

    const captureStart = performance.now();
    const source = await captureCollabSource(mount, drivePath);
    const { result } = await runTransformRequest(toRequest(source), {
        ...opts,
        priority,
        captureMs: performance.now() - captureStart,
    });
    return result;
}

// Only recalc-failed needs a line here: the child already logs every skipped blob
// and the runner logs each warning code with the job. The two fallbacks differ —
// a read serves replayed values, an import persists the parsed ones.
function surfaceWarning(warning: TransformWarning, kind: DocumentTransformRequest['kind']): void {
    if (warning.code !== 'recalc-failed') return;
    if (kind === 'import') {
        console.warn('[import] server recalc of imported sheets failed, persisting parsed values:', warning.message);
    } else {
        console.warn('[sheets] server recalc failed, serving replayed values:', warning.message);
    }
}

// Text results (preview bodies, indexable content) and binary results (exports). The
// job kind decides which the child returns and which limits it runs under. The runner
// validated the result pairs with the request (protocol.ts's resultMatchesRequest), so
// these narrow instead of re-checking.
export async function runTransformToPreview(
    mount: Mount,
    drivePath: DrivePath,
    job: CollabPreviewJob,
    opts: TransformOptions,
): Promise<PreviewResult> {
    return runDocumentTransform(mount, drivePath, opts, (source) => ({ ...job, source }));
}

export async function runTransformToExtractedText(
    mount: Mount,
    drivePath: DrivePath,
    job: ExtractTextJob,
    opts: TransformOptions,
): Promise<string> {
    const { text } = await runDocumentTransform(mount, drivePath, opts, (source) => ({ ...job, source }));
    return text;
}

export async function runTransformToBytes(
    mount: Mount,
    drivePath: DrivePath,
    job: ExportTransformJob,
    opts: TransformOptions,
): Promise<{ data: Buffer; zoom?: number }> {
    const { data, zoom } = await runDocumentTransform(mount, drivePath, opts, (source) => ({ ...job, source }));
    return { data: Buffer.from(data), zoom };
}

// The bytes-sourced counterpart of runDocumentTransform: the input is the file itself, read from
// the Mount after admission the same way a Yjs capture is. Null when the file is gone, so the
// caller serves no preview rather than an empty one.
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

// The same job with the bytes already in hand — a mail part has no Mount to read them from.
export async function runBytesTransformToText(
    job: BytesPreviewJob,
    data: ArrayBuffer,
    opts: TransformOptions & { captureMs?: number },
): Promise<string> {
    const { result } = await runTransformRequest({ ...job, data }, opts);
    return result.body;
}

// Imports carry uploaded bytes instead of a captured document, and hand back what
// the caller commits: the snapshot JSON (decoded, never parsed, on the main thread)
// for sheets, a ready Yjs update for documents and decks, each with its extracted media.
// The warnings come back too, for the summary an import answers with.
export type SheetsImportSnapshot = { snapshotJson: string; images: TransformMedia[]; warnings: TransformWarning[] };

export async function runImportToSnapshotJson(
    job: SheetsImportJob,
    data: ArrayBuffer,
    opts: TransformOptions,
): Promise<SheetsImportSnapshot> {
    const { result, warnings } = await runTransformRequest({ ...job, data }, opts);
    return { snapshotJson: new TextDecoder().decode(result.snapshotJson), images: result.images, warnings };
}

export async function runImportToDocumentUpdate(
    job: DocImportJob,
    data: ArrayBuffer,
    opts: TransformOptions,
): Promise<DocImportWorkerResult> {
    const { result } = await runTransformRequest({ ...job, data }, opts);
    return result;
}

// The warnings come back too: a pptx import's counted losses are the summary its caller answers with.
export async function runImportToSlidesUpdate(
    job: SlidesImportJob,
    data: ArrayBuffer,
    opts: TransformOptions,
): Promise<SlidesImportWorkerResult & { warnings: TransformWarning[] }> {
    const { result, warnings } = await runTransformRequest({ ...job, data }, opts);
    return { ...result, warnings };
}
