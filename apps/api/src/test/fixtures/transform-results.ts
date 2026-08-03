import type { DocImportWorkerResult, DocumentTransformResponse } from '../../lib/document/transform/protocol';

// The request kind decides which result member the Worker returns; these keep the
// transform assertions honest about which one they expect, in both the runner suite
// and the end-to-end document-transform suite.

export function previewBody(response: DocumentTransformResponse): string {
    if (!response.ok || !('body' in response.result)) {
        throw new Error(`expected a preview body, got ${JSON.stringify(response)}`);
    }
    return response.result.body;
}

export function exportBytes(response: DocumentTransformResponse): ArrayBuffer {
    if (!response.ok || !('data' in response.result)) {
        throw new Error(`expected export bytes, got ${JSON.stringify(response)}`);
    }
    return response.result.data;
}

export function importSnapshot(response: DocumentTransformResponse): string {
    if (!response.ok || !('snapshotJson' in response.result)) {
        throw new Error(`expected an import snapshot, got ${JSON.stringify(response)}`);
    }
    return new TextDecoder().decode(response.result.snapshotJson);
}

export function importDocUpdate(response: DocumentTransformResponse): DocImportWorkerResult {
    if (!response.ok || !('update' in response.result)) {
        throw new Error(`expected a document update, got ${JSON.stringify(response)}`);
    }
    return response.result;
}
