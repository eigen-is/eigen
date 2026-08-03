import type { DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../../core/errors';
import type { Mount } from '../../mount';
import { captureCollabSource } from './collab-source';
import type {
    CollabTransformJob,
    DocumentTransformRequest,
    ExportTransformJob,
    ImportTransformJob,
    PreviewTransformJob,
    TransformResult,
    TransformWarning,
} from './protocol';
import { documentTransformRunner, type TransformPriority } from './runner';

// The one main-thread path every document transform takes: admit the job, surface
// warnings, map failures — plus, for document-sourced jobs, the capture of the
// compressed Yjs blobs. A caller adds only its job fields and what it does with
// the result, so a new operation (doc/slides preview, HTML/PDF/DOCX export, DOCX
// import) is a thin wrapper plus a pure converter in the Worker — no new
// orchestration.
//
// There is deliberately no main-thread fallback: a runner 503 and controlled
// document errors keep their HTTP status, every other failure throws.

type TransformOptions = { priority?: TransformPriority; deadlineMs: number; signal?: AbortSignal };

async function runTransformRequest(
    request: DocumentTransformRequest,
    opts: TransformOptions & { captureMs?: number },
): Promise<TransformResult> {
    const response = await documentTransformRunner.run(request, {
        priority: opts.priority ?? 'foreground',
        deadlineMs: opts.deadlineMs,
        captureMs: opts.captureMs,
        signal: opts.signal,
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
    const captureStart = performance.now();
    const source = await captureCollabSource(mount, drivePath);
    return runTransformRequest({ ...job, source }, { ...opts, captureMs: performance.now() - captureStart });
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

// Text results (previews) and binary results (exports). The job kind decides which
// the Worker returns; the runner validates the pairing before it settles.
export async function runTransformToText(
    mount: Mount,
    drivePath: DrivePath,
    job: PreviewTransformJob,
    opts: TransformOptions,
): Promise<string> {
    const result = await runDocumentTransform(mount, drivePath, job, opts);
    if (!('body' in result)) throw new Error(`${job.kind} transform returned binary data`);
    return result.body;
}

export async function runTransformToBytes(
    mount: Mount,
    drivePath: DrivePath,
    job: ExportTransformJob,
    opts: TransformOptions,
): Promise<Buffer> {
    const result = await runDocumentTransform(mount, drivePath, job, opts);
    if (!('data' in result)) throw new Error(`${job.kind} transform returned text`);
    return Buffer.from(result.data);
}

// Imports carry uploaded bytes instead of a captured document, and hand back the
// snapshot JSON the caller commits — decoded, never parsed, on the main thread.
export async function runImportToSnapshotJson(
    job: ImportTransformJob,
    data: ArrayBuffer,
    opts: TransformOptions,
): Promise<string> {
    const result = await runTransformRequest({ ...job, data }, opts);
    if (!('snapshotJson' in result)) throw new Error(`${job.kind} transform returned no snapshot`);
    return new TextDecoder().decode(result.snapshotJson);
}
