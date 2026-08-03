import type { DrivePath } from '@workspace/lib/types/drive';
import { runTransformToText } from '../document/transform/run-transform';
import { PREVIEW_TRANSFORM_DEADLINE_MS, type TransformPriority } from '../document/transform/runner';
import type { Mount } from '../mount';

// Main-thread orchestration runs through the shared transform seam (capture → run
// → map), so a failing or overloaded runner surfaces as an error (503 passes
// through to the route; other failures let the preview cache serve stale or 404),
// never as an on-thread render. The renderer itself lives in eigensheets-render.ts,
// which only the Worker imports.
export async function generateEigensheetsPreview(
    mount: Mount,
    drivePath: DrivePath,
    priority: TransformPriority = 'foreground',
): Promise<string> {
    const job = { kind: 'preview', documentType: 'eigensheets' } as const;
    return runTransformToText(mount, drivePath, job, { priority, deadlineMs: PREVIEW_TRANSFORM_DEADLINE_MS });
}
