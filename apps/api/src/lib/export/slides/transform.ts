import { readVectorFromDoc } from '@workspace/lib/vector';
import type * as Y from 'yjs';
import { type ExportMedia, type TransformWarning, toTransferableBuffer } from '../../document/transform/protocol';
import { withSvgFallbacks } from '../office-image';
import { sanitizeSceneHtml } from '../sanitize';
import { eigenslidesToPptx } from './to-pptx';

// Materialized deck + prepared media → a .pptx. Runs inside the transform process (child.ts owns execution and loads
// this module only for a pptx; the main-thread orchestration lives in export-document.ts), so it never reaches the
// Mount or the preview cache. The rich-text filter the HTML export runs keeps a peer's javascript: link out of the file.
export async function renderEigenslidesPptx(
    doc: Y.Doc,
    title: string,
    media: ExportMedia[],
): Promise<{ data: ArrayBuffer; warnings: TransformWarning[] }> {
    const scene = sanitizeSceneHtml(readVectorFromDoc(doc));
    const pptx = eigenslidesToPptx(scene, await withSvgFallbacks(media), title);
    return { data: toTransferableBuffer(pptx), warnings: [] };
}
