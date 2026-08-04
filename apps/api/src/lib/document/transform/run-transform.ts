import type { DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../../core/errors';
import type { Mount } from '../../mount';
import { captureCollabSource } from './collab-source';
import type {
    CollabTransformJob,
    DocImportJob,
    DocImportWorkerResult,
    DocumentTransformRequest,
    ExportTransformJob,
    ExportWorkerResult,
    ExtractTextJob,
    ExtractTextResult,
    PreviewResult,
    PreviewTransformJob,
    SheetsImportJob,
    SheetsImportWorkerResult,
    TransformResult,
    TransformWarning,
} from './protocol';
import { documentTransformRunner, type RunOptions, TRANSFORM_LIMITS, type TransformPriority } from './runner';

// The one main-thread path every document transform takes: admit the job, surface
// warnings, map failures — plus, for document-sourced jobs, the capture of the
// compressed Yjs blobs. A caller adds only its job fields and what it does with
// the result, so a new operation (doc/slides preview, HTML/PDF/DOCX export, DOCX
// import) is a thin wrapper plus a pure converter in the Worker — no new
// orchestration.
//
// There is deliberately no main-thread fallback: a runner 503 and controlled
// document errors keep their HTTP status, every other failure throws.

// What a caller still decides; the limits belong to the job kind (TRANSFORM_LIMITS),
// and the capture time is measured here. prepMs: main-thread media preparation time,
// measured by the caller's wrapper — logged with the job so a fast Worker behind slow
// preparation stays visible.
type TransformOptions = Omit<RunOptions, 'priority' | 'deadlineMs' | 'admissionCostMs' | 'captureMs'> & {
    priority?: TransformPriority;
};

async function runTransformRequest(
    request: DocumentTransformRequest,
    opts: TransformOptions & { captureMs?: number },
): Promise<TransformResult> {
    const { priority = 'foreground', ...rest } = opts;
    const response = await documentTransformRunner.run(request, {
        ...rest,
        ...TRANSFORM_LIMITS[request.kind],
        priority,
    });
    if (!response.ok) {
        if (response.error.status) throw new ApiError(response.error.status, response.error.message);
        const what =
            request.kind === 'import' ? `${request.sourceFormat} import` : `${request.documentType} ${request.kind}`;
        throw new Error(`${what} transform failed (${response.error.code}): ${response.error.message}`);
    }
    for (const warning of response.warnings) surfaceWarning(warning, request.kind);
    return response.result;
}

async function runDocumentTransform(
    mount: Mount,
    drivePath: DrivePath,
    job: CollabTransformJob,
    opts: TransformOptions,
): Promise<TransformResult> {
    // Refuse before the capture: a job the runner will not admit must not pay for a
    // full read of the document's blobs (a refused reindex drain did, per row).
    const priority = opts.priority ?? 'foreground';
    documentTransformRunner.assertAdmissible(priority);

    const captureStart = performance.now();
    const source = await captureCollabSource(mount, drivePath);
    return runTransformRequest(
        { ...job, source },
        {
            ...opts,
            priority,
            captureMs: performance.now() - captureStart,
        },
    );
}

// Only recalc-failed needs a line here: the Worker already logs every skipped blob
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
// job kind decides which the Worker returns and which limits it runs under. The runner
// validated the result pairs with the request (protocol.ts's resultMatchesRequest), so
// these narrow instead of re-checking.
export async function runTransformToText(
    mount: Mount,
    drivePath: DrivePath,
    job: PreviewTransformJob,
    opts: TransformOptions,
): Promise<string> {
    const result = (await runDocumentTransform(mount, drivePath, job, opts)) as PreviewResult;
    return result.body;
}

export async function runTransformToExtractedText(
    mount: Mount,
    drivePath: DrivePath,
    job: ExtractTextJob,
    opts: TransformOptions,
): Promise<string> {
    const result = (await runDocumentTransform(mount, drivePath, job, opts)) as ExtractTextResult;
    return result.text;
}

export async function runTransformToBytes(
    mount: Mount,
    drivePath: DrivePath,
    job: ExportTransformJob,
    opts: TransformOptions,
): Promise<Buffer> {
    const result = (await runDocumentTransform(mount, drivePath, job, opts)) as ExportWorkerResult;
    return Buffer.from(result.data);
}

// Imports carry uploaded bytes instead of a captured document, and hand back what
// the caller commits: the snapshot JSON (decoded, never parsed, on the main thread)
// for sheets, a ready Yjs update plus extracted media for documents.
export async function runImportToSnapshotJson(
    job: SheetsImportJob,
    data: ArrayBuffer,
    opts: TransformOptions,
): Promise<string> {
    const result = (await runTransformRequest({ ...job, data }, opts)) as SheetsImportWorkerResult;
    return new TextDecoder().decode(result.snapshotJson);
}

export async function runImportToDocumentUpdate(
    job: DocImportJob,
    data: ArrayBuffer,
    opts: TransformOptions,
): Promise<DocImportWorkerResult> {
    return (await runTransformRequest({ ...job, data }, opts)) as DocImportWorkerResult;
}
