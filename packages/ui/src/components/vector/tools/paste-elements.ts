// Clipboard elements → what the doc hook needs to add them: partials in z-order, the index→source-id
// map the arrow-binding remap keys on, and the cross-mount image manifest. Pure — the hook owns the
// transacts, this owns the decisions.

import { needsReUpload } from '@workspace/lib/clipboard';
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
// starts with no comments, the same rule duplicateElementsInDoc follows.
function pastePartial(el: VectorElement): NewVectorElement {
    const { id, index, ...rest } = el;
    return { ...rest, commentCardIds: '' };
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
            // The image items ARE the manifest: an image with no item beside it was copied mid-upload,
            // so its bytes are fetchable from nowhere — dropping it beats pasting a broken reference.
            const item = imageItems.find((i) => i.mediaName === el.mediaName);
            if (!item) continue;
            if (mediaFolderId && needsReUpload(item.sourceParentId, mediaFolderId)) {
                // Optimistic add under a pending name; the hook swaps the real one in once it lands.
                partial.mediaName = `pending:${crypto.randomUUID()}`;
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
