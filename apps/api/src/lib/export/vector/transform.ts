import { escapeHtml } from '@workspace/lib/html';
import { isTransparent, readVectorFromDoc, sceneToSvg, type VectorScene } from '@workspace/lib/vector';
import type * as Y from 'yjs';
import { ApiError } from '../../core/errors';
import { spliceAfterSvgOpenTag, toDataUriMap } from '../../document/media';
import {
    type TransformMedia,
    type TransformWarning,
    toTransferableText,
    type VectorExportFormat,
} from '../../document/transform/protocol';
import { getFontCSS, getFontFaceCSSForFamilies } from '../fonts';
import { sanitizeExportHtml } from '../sanitize';

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
        // A collaborator can put arbitrary strings in the schemaless scene, so the assembled
        // SVG runs through the shared export sanitizer (the documented SSRF closure) exactly
        // like slides/sheets — even though the preview surface trusts the serializer.
        const svg = sanitizeExportHtml(renderSceneSvg(scene, dataUriMap, { inlineFonts: true }));
        return { data: toTransferableText(svg), warnings: [] };
    }

    // pdf-html: nothing to print from an empty scene (the SVG has a zero-size viewBox).
    if (scene.elements.length === 0) throw new ApiError(400, 'The drawing is empty');
    const paperScene = isTransparent(scene.meta.background)
        ? { ...scene, meta: { ...scene.meta, background: PDF_PAPER } }
        : scene;
    // The page is sized off the serializer's own width/height, read before sanitizing (the
    // sanitizer may reorder attributes). Fonts ride in the wrapping document's <style>
    // (getFontCSS, whole faces), so the SVG itself carries only the sanitized drawing.
    const rawSvg = renderSceneSvg(paperScene, dataUriMap, { inlineFonts: false });
    const { width, height } = svgDimensions(rawSvg);
    const html = wrapInPdfDocument(title, sanitizeExportHtml(rawSvg), width, height);
    return { data: toTransferableText(html), warnings: [] };
}

// The drawing's own SVG, with the @font-face blocks its text uses injected into a <defs>
// <style> for the standalone (svg) download. sceneToSvg emits no top-level <defs>, so the
// style is spliced in right after the opening <svg> tag.
function renderSceneSvg(scene: VectorScene, dataUriMap: Map<string, string>, opts: { inlineFonts: boolean }): string {
    const svg = sceneToSvg(scene, { resolveMedia: (mediaName) => dataUriMap.get(mediaName) ?? null });
    if (!opts.inlineFonts) return svg;

    const faceCSS = getFontFaceCSSForFamilies(usedFontFamilies(scene));
    if (!faceCSS) return svg;

    return spliceAfterSvgOpenTag(svg, `<defs><style>${faceCSS}</style></defs>`);
}

// The EIGEN_FONTS families the drawing's text actually uses — text elements and the labels
// bound to arrows. An element with no text contributes no family, so the SVG inlines only
// the faces it renders with.
function usedFontFamilies(scene: VectorScene): Set<string> {
    const families = new Set<string>();
    for (const el of scene.elements) {
        if ((el.type === 'text' || el.type === 'arrow') && el.text !== '') families.add(el.fontFamily);
    }
    return families;
}

// A minimal page sized to the drawing so WeasyPrint prints one PDF page the size of the
// artwork, with the same inlined-font set the screen uses. The SVG arrives already
// sanitized; the wrapper and its fonts are ours.
function wrapInPdfDocument(title: string, svg: string, width: number, height: number): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    <style>${getFontCSS()}
@page { size: ${width}px ${height}px; margin: 0; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { margin: 0; }
svg { display: block; }</style>
</head>
<body>
    ${svg}
</body>
</html>`;
}

// The drawing's pixel size, read off the width/height sceneToSvg wrote on the root <svg>.
// An empty scene never reaches here (pdf rejects it), so the attributes are always present.
function svgDimensions(svg: string): { width: number; height: number } {
    const width = Number(svg.match(/^<svg[^>]*\bwidth="([\d.]+)"/)?.[1] ?? 0);
    const height = Number(svg.match(/^<svg[^>]*\bheight="([\d.]+)"/)?.[1] ?? 0);
    return { width, height };
}
