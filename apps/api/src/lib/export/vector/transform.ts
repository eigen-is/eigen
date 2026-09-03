import { isTransparentColor, readVectorFromDoc, sceneToSvg, type VectorScene } from '@workspace/lib/vector';
import type * as Y from 'yjs';
import { ApiError } from '../../core/errors';
import { spliceAfterSvgOpenTag, toDataUriMap } from '../../document/media';
import {
    type TransformMedia,
    type TransformWarning,
    toTransferableText,
    type VectorExportFormat,
} from '../../document/transform/protocol';
import { drawingPage } from '../canvas/render';
import { canvasHtmlDocument } from '../canvas/transform';
import { getFontFaceCSSForFamilies } from '../fonts';
import { sanitizeExportHtml } from '../sanitize';

// A rich-text box renders as an HTML <div> inside <foreignObject>, and DOMPurify drops both by
// default: foreignObject is not in its SVG allowlist, and HTML nested in SVG survives only under a
// declared integration point. Allowing the pair keeps the box; its markup still goes through the
// ordinary HTML pass, so scripts, event handlers and non-data: refs come out exactly as they do in
// the doc and slides exports.
const RICH_TEXT_TAGS = { ADD_TAGS: ['foreignObject'], HTML_INTEGRATION_POINTS: { foreignobject: true } };

// A transparent drawing keeps its transparency in the SVG download but exports as white
// paper for PDF — WeasyPrint has no canvas behind the page.
const PDF_PAPER = '#ffffff';

// Materialized doc + prepared media → export bytes. Runs inside the transform Worker
// (worker.ts owns execution; the main-thread orchestration lives in export-document.ts).
// This module must not reach the Mount or the preview cache — the Worker imports it.
export function renderEigenvectorExport(
    doc: Y.Doc,
    format: VectorExportFormat,
    title: string,
    media: TransformMedia[],
): { data: ArrayBuffer; warnings: TransformWarning[] } {
    const scene = readVectorFromDoc(doc);
    const dataUriMap = toDataUriMap(media);

    if (format === 'svg') {
        // A collaborator can put arbitrary strings in the schemaless scene — including a rich-text
        // box's raw HTML — so the assembled SVG runs through the shared sanitizer (the documented
        // SSRF closure) exactly like slides/sheets and the preview.
        const svg = sanitizeExportHtml(renderSceneSvg(scene, dataUriMap), RICH_TEXT_TAGS);
        return { data: toTransferableText(svg), warnings: [] };
    }

    // pdf-html: the drawing as compositor layers on a page sized to the artwork. Rich text prints
    // because it is an HTML div here — WeasyPrint ignores the foreignObject the svg arm uses.
    const paperScene = isTransparentColor(scene.meta.background)
        ? { ...scene, meta: { ...scene.meta, background: PDF_PAPER } }
        : scene;
    const page = drawingPage(paperScene, (mediaName) => dataUriMap.get(mediaName) ?? null);
    // Nothing to print, and nothing to size a page from.
    if (!page) throw new ApiError(400, 'The drawing is empty');
    // The shared canvas document sanitizes the assembled body and owns the @page rule, the fonts and
    // the reset — a deck's pages and a drawing's single page leave through the same wrapper.
    const html = canvasHtmlDocument({ title, pages: [page], scale: 1, mode: 'pdf' });
    return { data: toTransferableText(html), warnings: [] };
}

// The drawing's own SVG, with the @font-face blocks its text uses injected into a <defs>
// <style> for the standalone (svg) download. sceneToSvg emits no top-level <defs>, so the
// style is spliced in right after the opening <svg> tag.
function renderSceneSvg(scene: VectorScene, dataUriMap: Map<string, string>): string {
    const svg = sceneToSvg(scene, { resolveMedia: (mediaName) => dataUriMap.get(mediaName) ?? null });
    const faceCSS = getFontFaceCSSForFamilies(usedFontFamilies(scene));
    if (!faceCSS) return svg;
    return spliceAfterSvgOpenTag(svg, `<defs><style>${faceCSS}</style></defs>`);
}

// The EIGEN_FONTS families the drawing's text actually uses — rich-text boxes and the labels
// bound to arrows. An element with no text contributes no family, so the SVG inlines only
// the faces it renders with.
function usedFontFamilies(scene: VectorScene): Set<string> {
    const families = new Set<string>();
    for (const el of scene.elements) {
        if (el.type === 'richtext' && el.html !== '') families.add(el.fontFamily);
        if (el.type === 'arrow' && el.text !== '') families.add(el.fontFamily);
    }
    return families;
}
