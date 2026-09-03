// Clipboard elements → what the doc hook needs to add them: partials in z-order, the index→source-id
// map the arrow-binding remap keys on, and the cross-mount image manifest. Pure — the hook owns the
// transacts, this owns the decisions.

import { needsReUpload } from '@workspace/lib/clipboard';
import { PENDING_PREFIX } from '@workspace/lib/drive';
import { sanitizeToLightEditorHtml } from '@workspace/lib/html-dom';
import type { EigenClipboardImageItem } from '@workspace/lib/types/clipboard';
import type { VectorElement } from '@workspace/lib/vector';
import type { NewVectorElement } from '../hooks/use-canvas-doc';
import type { PastedArrow } from './binding';

export type PastePlan = {
    partials: NewVectorElement[];
    // partial index → the id the element had when it was copied, for remapPastedArrows.
    cloneIds: Map<number, string>;
    arrowRemaps: PastedArrow[];
    // Images whose bytes live in another container: index → the typed item that can fetch them.
    crossMount: { index: number; item: EigenClipboardImageItem }[];
};

// The whole stored record minus what the writer allocates (id, index). `commentCardIds` clears: a copy
// starts with no comments, the same rule duplicateElementsInDoc follows. Rich text's `html` is forgeable
// (any web page can write our MIME), so it passes the LightEditor allowlist before it reaches the doc —
// the same sanitizer the mount seam runs, so nothing hostile is ever stored.
function pastePartial(el: VectorElement): NewVectorElement {
    const { id, index, ...rest } = el;
    const partial: NewVectorElement = { ...rest, commentCardIds: '' };
    if (el.type === 'richtext') partial.html = sanitizeToLightEditorHtml(el.html);
    return partial;
}

export function planElementsPaste(
    elements: VectorElement[],
    imageItems: EigenClipboardImageItem[],
    mediaFolderId: string | null,
): PastePlan {
    const plan: PastePlan = { partials: [], cloneIds: new Map(), arrowRemaps: [], crossMount: [] };
    for (const el of elements) {
        const partial = pastePartial(el);
        if (el.type === 'image') {
            // No media/ folder means no upload target and nothing to resolve a name against, so an image
            // is dropped rather than pasted as a broken reference (insertImageFiles bails the same way).
            if (!mediaFolderId) continue;
            // The image items ARE the manifest: an image with no item beside it was copied mid-upload,
            // so its bytes are fetchable from nowhere — dropping it beats pasting a broken reference.
            const item = imageItems.find((i) => i.mediaName === el.mediaName);
            if (!item) continue;
            if (needsReUpload(item.sourceParentId, mediaFolderId)) {
                // Optimistic add under a pending name; the hook swaps the real one in once it lands.
                partial.mediaName = `${PENDING_PREFIX}${crypto.randomUUID()}`;
                plan.crossMount.push({ index: plan.partials.length, item });
            }
        }
        if (el.type === 'arrow') {
            plan.arrowRemaps.push({
                index: plan.partials.length,
                startBinding: el.startBinding,
                endBinding: el.endBinding,
            });
        }
        plan.cloneIds.set(plan.partials.length, el.id);
        plan.partials.push(partial);
    }
    return plan;
}
