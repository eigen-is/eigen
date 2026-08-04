import type { DrivePath } from '@workspace/lib/types/drive';
import type * as Y from 'yjs';
import { materializeYjsState } from '../../lib/collab/yjs-loader';
import { captureCollabSource } from '../../lib/document/transform/collab-source';
import type { DocImportWorkerResult, DocumentTransformResponse } from '../../lib/document/transform/protocol';
import type { Mount } from '../../lib/mount';

// What the transform suites share: the persisted document every reader materializes,
// plus the accessors for the result member each request kind returns — they keep the
// assertions honest about which one they expect, in both the runner suite and the
// end-to-end document-transform suite.

// The persisted document the way every reader gets one: capture the container's Yjs
// blobs and materialize them, exactly what the transform Worker does. The caller owns
// the returned doc and destroys it.
export async function readPersistedDoc(mount: Mount, drivePath: DrivePath): Promise<Y.Doc> {
    return materializeYjsState(await captureCollabSource(mount, drivePath)).doc;
}

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
