import type * as Y from 'yjs';
import { peakRss } from '../../core/peak-rss';
import { sanitizeMedia } from '../media';
import {
    type BytesPreviewJob,
    type BytesTransformJob,
    type ChildAck,
    type ChildRequestEnvelope,
    type ChildResponseEnvelope,
    type CollabPreviewJob,
    type CollabTransformJob,
    type DocumentTransformRequest,
    type DocumentTransformResponse,
    type ExportTransformJob,
    type ImportTransformJob,
    type PreviewResult,
    type TransformResult,
    type TransformWarning,
    toTransformError,
} from './protocol';

// One-shot document-transform process: acknowledges one request, sends one response,
// and is killed by the runner. Operation dispatch stays a closed switch over the
// request union — nothing from the message can select a module or path.
// Format-specific modules load via dynamic import so a doc preview never evaluates
// the sheet engine, and a deck export never loads lowlight.

async function renderPreview(
    request: CollabPreviewJob,
    doc: Y.Doc,
): Promise<PreviewResult & { warnings: TransformWarning[] }> {
    switch (request.documentType) {
        case 'eigensheets': {
            const { renderEigensheetsPreviewBody } = await import('../../preview/eigensheets-render');
            return renderEigensheetsPreviewBody(doc, request.mediaUrls);
        }
        case 'eigendoc': {
            const { renderEigendocPreviewBody } = await import('../../preview/eigendoc-render');
            return renderEigendocPreviewBody(doc, request.mediaUrls);
        }
        case 'eigenslides': {
            const { renderEigenslidesPreviewBody } = await import('../../preview/eigenslides-render');
            return renderEigenslidesPreviewBody(doc, request.mediaUrls);
        }
        case 'eigenvector': {
            const { renderEigenvectorPreviewBody } = await import('../../preview/eigenvector-render');
            return renderEigenvectorPreviewBody(doc, request.mediaUrls);
        }
    }
}

async function renderExport(
    request: ExportTransformJob,
    doc: Y.Doc,
): Promise<{ data: ArrayBuffer; warnings: TransformWarning[] }> {
    const media = await sanitizeMedia(request.media);
    switch (request.documentType) {
        case 'eigensheets': {
            const { renderEigensheetsExport } = await import('../../export/sheets/transform');
            return renderEigensheetsExport(doc, request.format, request.title, media);
        }
        case 'eigendoc': {
            const { renderEigendocExport } = await import('../../export/doc/transform');
            return renderEigendocExport(doc, request.format, request.title, media, request.publicOrigin);
        }
        case 'eigenslides': {
            const { renderEigenslidesExport } = await import('../../export/slides/transform');
            return renderEigenslidesExport(doc, request.format, request.title, media);
        }
        case 'eigenvector': {
            const { renderEigenvectorExport } = await import('../../export/vector/transform');
            return renderEigenvectorExport(doc, request.format, request.title, media);
        }
    }
}

async function runImport(request: ImportTransformJob & { data: ArrayBuffer }): Promise<DocumentTransformResponse> {
    switch (request.sourceFormat) {
        case 'xlsx': {
            const { importXlsxToSheetsSnapshot } = await import('../../import/sheets/transform');
            const { snapshotJson, warnings } = importXlsxToSheetsSnapshot(request.data);
            return { ok: true, result: { snapshotJson }, warnings };
        }
        case 'docx': {
            const { importDocxToEigendocUpdate } = await import('../../import/doc/transform');
            const { warnings, ...result } = importDocxToEigendocUpdate(request.data, request.publicOrigin);
            return { ok: true, result, warnings };
        }
        case 'pptx': {
            const { importPptxToSlidesUpdate } = await import('../../import/slides/transform');
            const { warnings, ...result } = importPptxToSlidesUpdate(request.data, request);
            return { ok: true, result, warnings };
        }
    }
}

// The bytes-sourced kinds read what they were handed: an upload to import, or the .vcf, .eml or .ics a
// preview serves as a typed payload. Closed over the kind like every other dispatch here.
async function runBytesRequest(request: BytesTransformJob & { data: ArrayBuffer }): Promise<DocumentTransformResponse> {
    switch (request.kind) {
        case 'import':
            return runImport(request);
        case 'preview':
            // The preview result carries a string, so the payload rides back as the JSON the route serves.
            return { ok: true, result: { body: await buildBytesPreviewJson(request) }, warnings: [] };
    }
}

async function buildBytesPreviewJson(request: BytesPreviewJob & { data: ArrayBuffer }): Promise<string> {
    switch (request.documentType) {
        case 'vcard': {
            const { buildVCardPreviewPayload } = await import('../../preview/vcard-preview');
            return JSON.stringify(buildVCardPreviewPayload(request.data));
        }
        case 'eml': {
            const { buildEmlPreviewPayload } = await import('../../preview/eml-preview');
            return JSON.stringify(buildEmlPreviewPayload(request.data));
        }
        case 'ics': {
            const { buildIcsPreviewPayload } = await import('../../preview/ics-preview');
            return JSON.stringify(buildIcsPreviewPayload(request.data));
        }
    }
}

// The three document-sourced kinds dispatch off one materialized doc, so the
// skipped-blob warning is appended once by the caller rather than in every arm.
async function renderCollabRequest(
    request: CollabTransformJob,
    doc: Y.Doc,
): Promise<{ result: TransformResult; warnings: TransformWarning[] }> {
    switch (request.kind) {
        case 'preview': {
            const { warnings, ...result } = await renderPreview(request, doc);
            return { result, warnings };
        }
        case 'export': {
            const { data, warnings } = await renderExport(request, doc);
            return { result: { data }, warnings };
        }
        case 'extract-text': {
            const { extractCollabText } = await import('../../search/extract-render');
            const { text, warnings } = await extractCollabText(request.documentType, doc);
            return { result: { text }, warnings };
        }
    }
}

async function handleRequest(request: DocumentTransformRequest): Promise<DocumentTransformResponse> {
    // Bytes-sourced jobs carry their own input — no document to materialize.
    if ('data' in request) return runBytesRequest(request);

    // Preview and export both read the persisted document, so materialization is shared.
    const { materializeYjsState } = await import('../../collab/yjs-loader');
    const { doc, blobsSkipped } = materializeYjsState(request.source, undefined, 'transform-process');

    const { result, warnings } = await renderCollabRequest(request, doc);
    if (blobsSkipped > 0) warnings.push({ code: 'corrupt-blobs-skipped', count: blobsSkipped });
    return { ok: true, result, warnings };
}

process.on('message', async ({ jobId, request }: ChildRequestEnvelope) => {
    const ack: ChildAck = { jobId, ack: true };
    process.send?.(ack);
    const startedAt = performance.now();
    // Never an exit after the send: it would drop the reply. The runner kills the child once it has it.
    const reply = (response: DocumentTransformResponse) => {
        const envelope: ChildResponseEnvelope = {
            jobId,
            response,
            transformMs: performance.now() - startedAt,
            peakRssBytes: peakRss(),
        };
        process.send?.(envelope);
    };
    // The send serializes the result, which can fail too, out of memory included: it is answered like any throw.
    try {
        reply(await handleRequest(request));
    } catch (err) {
        reply({ ok: false, error: toTransformError(err) });
    }
});

// A parent that died first leaves no one to kill the child.
process.on('disconnect', () => process.exit(0));
