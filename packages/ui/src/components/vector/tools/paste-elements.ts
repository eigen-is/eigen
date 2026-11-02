// Plans the paste of a canvas copy's own elements: the partials to add in z-order, the id each one had when it was
// copied, which the arrow-binding remap keys on, and the images whose bytes must be uploaded again. It decides and
// writes nothing. The clipboard hook owns the transacts, and it plans another app's items into the same PastePlan.

import { needsReUpload } from '@workspace/lib/clipboard';
import { PENDING_PREFIX } from '@workspace/lib/drive';
import { sanitizeToLightEditorHtml } from '@workspace/lib/html-dom';
import type { EigenClipboardImageItem } from '@workspace/lib/types/clipboard';
import type { NewVectorElement, VectorElement } from '@workspace/lib/vector';
import type { VectorTextFont } from '../text-measure';
import type { PastedArrow } from './binding';

export type PastePlan = {
    partials: NewVectorElement[];
    // partial index → the id the element had when it was copied, for remapPastedArrows.
    cloneIds: Map<number, string>;
    arrowRemaps: PastedArrow[];
    // Images whose bytes live in another container: index → the typed item that can fetch them.
    crossMount: { index: number; item: EigenClipboardImageItem }[];
    // Text boxes sized by a measure of their text as the paste landed. Each keeps the text, its font and the width it
    // was given, so the hook can measure it again once the slices of that text load.
    measuredText: { index: number; text: string; font: VectorTextFont; width: number }[];
};

// The whole stored record minus what the writer allocates: the id, the index and the seed. A copy takes its own
// jitter, as a duplicate does. `commentCardIds` clears, because a copy starts with no comments, the rule
// duplicateElementsInDoc follows too. Any web page can write our MIME, so the `html` of a text box or a shape passes
// the LightEditor allowlist before it reaches the doc. It is the sanitizer the mount seam runs, so nothing hostile is
// ever stored.
function pastePartial(el: VectorElement): NewVectorElement {
    const { id, index, seed, ...rest } = el;
    const partial: NewVectorElement = { ...rest, commentCardIds: '' };
    if ('html' in el) partial.html = sanitizeToLightEditorHtml(el.html);
    return partial;
}

export function planElementsPaste(
    elements: VectorElement[],
    imageItems: EigenClipboardImageItem[],
    mediaFolderId: string | null,
): PastePlan {
    const plan: PastePlan = { partials: [], cloneIds: new Map(), arrowRemaps: [], crossMount: [], measuredText: [] };
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
            // An image from another media/ folder, or naming none, is uploaded again here; a failed upload drops it.
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
