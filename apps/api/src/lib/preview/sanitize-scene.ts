import type { VectorScene } from '@workspace/lib/vector';
import { sanitizeExportHtml } from '../export/sanitize';

// A preview body is injected as live DOM in the drive hero and the lightbox, where a <style> block
// styles the whole app rather than the element that carries it — a blanked UI or an invisible overlay
// for everyone who browses the folder. Nothing a rich-text box legitimately holds is a style element.
// <link>, <meta> and <base> are not in DOMPurify's allowlist to begin with.
const PREVIEW_TAGS = { FORBID_TAGS: ['style'] };

// Every element that carries an `html` body, with that body filtered: DOMPurify plus the shared
// restriction to data: refs, so nothing a collaborator wrote in it can fetch from anywhere.
export function sanitizeSceneHtml(scene: VectorScene): VectorScene {
    return {
        ...scene,
        elements: scene.elements.map((el) =>
            'html' in el ? { ...el, html: sanitizeExportHtml(el.html, PREVIEW_TAGS) } : el,
        ),
    };
}
