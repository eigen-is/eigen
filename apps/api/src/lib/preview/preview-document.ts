// The one main-thread entry of a collab document's preview, which the preview cache calls. It prepares the URL map of
// the document's media beside the Mount, then the transform process renders the preview body.

import type { DrivePath } from '@workspace/lib/types/drive';
import { buildPreviewUrlMap } from '../document/media';
import type { CollabPreviewJob, PreviewResult } from '../document/transform/protocol';
import { runTransformToPreview } from '../document/transform/run-transform';
import type { TransformPriority } from '../document/transform/runner';
import type { Mount } from '../mount';

export type PreviewDocumentType = CollabPreviewJob['documentType'];

// No signal: a preview may finish after the client disconnects, because its result fills the cache.
export async function generateDocumentPreview(
    documentType: PreviewDocumentType,
    mount: Mount,
    drivePath: DrivePath,
    priority: TransformPriority = 'foreground',
): Promise<PreviewResult> {
    // Media resolves here, as the transform process never sees a Mount.
    const prepStart = performance.now();
    const mediaUrls = await buildPreviewUrlMap(mount, drivePath);
    const job = { kind: 'preview', documentType, mediaUrls } as const;
    return runTransformToPreview(mount, drivePath, job, { priority, prepMs: performance.now() - prepStart });
}
