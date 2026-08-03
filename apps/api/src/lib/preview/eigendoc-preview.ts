import type { DrivePath } from '@workspace/lib/types/drive';
import { buildPreviewUrlMap } from '../document/media';
import { runTransformToText } from '../document/transform/run-transform';
import type { TransformPriority } from '../document/transform/runner';
import type { Mount } from '../mount';

// Main-thread orchestration runs through the shared transform seam (prepare media →
// capture → run → map). No signal: a preview may finish after the client disconnects
// because its result populates the cache. The renderer itself lives in
// eigendoc-render.ts, which only the Worker imports.
export async function generateEigendocPreview(
    mount: Mount,
    drivePath: DrivePath,
    priority: TransformPriority = 'foreground',
): Promise<string> {
    const prepStart = performance.now();
    const mediaUrls = await buildPreviewUrlMap(mount, drivePath);
    const job = { kind: 'preview', documentType: 'eigendoc', mediaUrls } as const;
    return runTransformToText(mount, drivePath, job, {
        priority,
        prepMs: performance.now() - prepStart,
    });
}
