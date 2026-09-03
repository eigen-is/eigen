import type { DrivePath } from '@workspace/lib/types/drive';
import { buildPreviewUrlMap } from '../document/media';
import type { PreviewTransformJob } from '../document/transform/protocol';
import { runTransformToText } from '../document/transform/run-transform';
import type { TransformPriority } from '../document/transform/runner';
import type { Mount } from '../mount';

export type PreviewDocumentType = PreviewTransformJob['documentType'];

// The one main-thread preview entry (export-document.ts's counterpart). No signal:
// a preview may finish after disconnect because its result populates the cache.
export async function generateDocumentPreview(
    documentType: PreviewDocumentType,
    mount: Mount,
    drivePath: DrivePath,
    priority: TransformPriority = 'foreground',
): Promise<string> {
    // Doc/slides/vector media resolves here — the Worker never sees a Mount.
    if (documentType === 'eigensheets') {
        return runTransformToText(mount, drivePath, { kind: 'preview', documentType }, { priority });
    }

    const prepStart = performance.now();
    const mediaUrls = await buildPreviewUrlMap(mount, drivePath);
    const job = { kind: 'preview', documentType, mediaUrls } as const;
    return runTransformToText(mount, drivePath, job, { priority, prepMs: performance.now() - prepStart });
}
