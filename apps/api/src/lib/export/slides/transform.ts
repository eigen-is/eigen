// A deck's export inside the transform process: the HTML download and the printed document through the canvas pages,
// and the pptx. Each returns its bytes and the warnings that count what it left out.

import { readVectorFromDoc } from '@workspace/lib/vector';
import type * as Y from 'yjs';
import type {
    ExportMediaLoader,
    ExportWorkerResult,
    SlidesExportFormat,
    TransformWarning,
} from '../../document/transform/protocol';
import { lossCounter, toTransferableBuffer } from '../../document/transform/protocol';
import { sceneMediaNames } from '../canvas/render';
import { renderEigenslidesHtml } from '../canvas/transform';
import { withSvgFallbacks } from '../office-image';
import { sanitizeSceneHtml } from '../sanitize';

// Materialized deck + prepared media → export bytes. Runs inside the transform process (child.ts owns execution; the
// main-thread orchestration lives in export-document.ts), so it never reaches the Mount or the preview cache. HTML and
// PDF are the canvas pages; the pptx is written from the scene by pptx/to-pptx.ts, which loads lazily so an HTML export
// never evaluates it. The rich-text filter the HTML export runs keeps a peer's javascript: link out of the pptx.
export async function renderEigenslidesExport(
    doc: Y.Doc,
    format: SlidesExportFormat,
    title: string,
    loadMedia: ExportMediaLoader,
): Promise<ExportWorkerResult & { warnings: TransformWarning[] }> {
    if (format !== 'pptx') return renderEigenslidesHtml(doc, format, title, loadMedia);
    const { writePptx } = await import('./pptx/to-pptx');
    const scene = sanitizeSceneHtml(readVectorFromDoc(doc));
    const media = await withSvgFallbacks(await loadMedia(sceneMediaNames(scene)));
    const losses = lossCounter();
    const pptx = writePptx(scene, { title, media, lost: losses.lost });
    return { data: toTransferableBuffer(pptx), warnings: losses.warnings() };
}
