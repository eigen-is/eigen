import type { DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../../core/errors';
import type { Mount } from '../../mount';
import { captureCollabSource } from './collab-source';
import type {
    DocumentTransformJob,
    ExportTransformJob,
    ExportWorkerResult,
    PreviewResult,
    PreviewTransformJob,
    TransformWarning,
} from './protocol';
import { documentTransformRunner, type TransformPriority } from './runner';

// The one main-thread path every document transform takes: capture the document's
// compressed Yjs blobs, admit the job, surface warnings, map failures. A caller
// adds only its job fields and what it does with the result, so a new operation
// (doc/slides preview, HTML/PDF/DOCX export) is a thin wrapper plus a pure renderer
// in the Worker — no new orchestration.
//
// There is deliberately no main-thread fallback: a runner 503 and controlled
// document errors keep their HTTP status, every other failure throws.

type TransformOptions = { priority?: TransformPriority; deadlineMs: number; signal?: AbortSignal };

async function runDocumentTransform(
    mount: Mount,
    drivePath: DrivePath,
    job: DocumentTransformJob,
    opts: TransformOptions,
): Promise<PreviewResult | ExportWorkerResult> {
    const captureStart = performance.now();
    const source = await captureCollabSource(mount, drivePath);
    const response = await documentTransformRunner.run(
        { ...job, source },
        {
            priority: opts.priority ?? 'foreground',
            deadlineMs: opts.deadlineMs,
            captureMs: performance.now() - captureStart,
            signal: opts.signal,
        },
    );
    if (!response.ok) {
        if (response.error.status) throw new ApiError(response.error.status, response.error.message);
        throw new Error(
            `${job.documentType} ${job.kind} transform failed (${response.error.code}): ${response.error.message}`,
        );
    }
    for (const warning of response.warnings) surfaceWarning(warning);
    return response.result;
}

// Only recalc-failed needs a line here: the Worker already logs every skipped blob
// and the runner logs each warning code with the job.
function surfaceWarning(warning: TransformWarning): void {
    if (warning.code === 'recalc-failed') {
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
