// A PastePlan is what one paste adds to the canvas, before anything is written: the partials to add in z-order, and
// what must happen to some of them once they are added. This file plans each kind of paste, such as a canvas copy's own
// elements, another app's items and plain text. The clipboard hook decides which one a paste is and writes the plan.

import { newChartSpecParts } from '@workspace/lib/charts';
import { clipboardTextItemHasContent, needsReUpload, readClipboardBox } from '@workspace/lib/clipboard';
import { PENDING_PREFIX } from '@workspace/lib/drive';
import { textToParagraphHtml } from '@workspace/lib/html';
import { sanitizeToLightEditorHtml } from '@workspace/lib/html-dom';
import type { EigenClipboardImageItem, EigenClipboardItem } from '@workspace/lib/types/clipboard';
import type { NewVectorElement, Point, StyleDefaults, TextAlign, VectorElement } from '@workspace/lib/vector';
import { canvasPtToPx, IMAGE_CASCADE_OFFSET, readClipboardTypography, textBoxDefaults } from '@workspace/lib/vector';
import type { VectorTextFont } from '../text-measure';
import { measureVectorText } from '../text-measure';
import type { PastedArrow } from './binding';

export type PastePlan = {
    partials: NewVectorElement[];
    // The id each partial had when it was copied, by the partial's index, for remapPastedArrows.
    cloneIds: Map<number, string>;
    arrowRemaps: PastedArrow[];
    // Images whose bytes live in another container, by the partial's index, with the typed item that can fetch them.
    crossMount: { index: number; item: EigenClipboardImageItem }[];
    // Text boxes sized by a measure of their text as the paste landed. Each keeps the text, its font and the width it
    // was given, so the hook can measure it again once the slices of that text load.
    measuredText: { index: number; text: string; font: Required<VectorTextFont>; width: number }[];
};

export function emptyPastePlan(): PastePlan {
    return { partials: [], cloneIds: new Map(), arrowRemaps: [], crossMount: [], measuredText: [] };
}

export function planElementsPaste(
    elements: VectorElement[],
    imageItems: EigenClipboardImageItem[],
    mediaFolderId: string | null,
): PastePlan {
    const plan = emptyPastePlan();
    for (const el of elements) {
        const partial = pastePartial(el);
        if (el.type === 'image') {
            // No media/ folder means no upload target and nothing to resolve a name against, so an image
            // is dropped rather than pasted as a broken reference (insertImageFiles bails the same way).
            if (!mediaFolderId) continue;
            // The image items list every image the copy could serialize. An image with no item was copied mid-upload,
            // so its bytes can be fetched from nowhere, and it is dropped rather than pasted as a broken reference.
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

// A payload with no elements item of ours: another app's images, charts and text. Each lands centered on `anchor`,
// cascading so a paste of several stays visible. An image takes the size its item gives. Text is measured here,
// because the size another app gives is never written onto text. `slideWidth` is a deck's, which a text item's size in
// pt converts at; a drawing has none.
export function planForeignPaste(
    items: readonly EigenClipboardItem[],
    anchor: Point,
    mediaFolderId: string | null,
    styleDefaults: StyleDefaults,
    slideWidth: number | undefined,
): PastePlan {
    const plan = emptyPastePlan();
    let cascade = 0;
    const placeAt = (w: number, h: number): Point => {
        const off = cascade * IMAGE_CASCADE_OFFSET;
        cascade += 1;
        return { x: anchor.x - w / 2 + off, y: anchor.y - h / 2 + off };
    };
    for (const item of items) {
        const box = readClipboardBox(item);
        const angle = box.angle ?? 0;
        if (item.type === 'image') {
            // No media/ folder means no upload target and nothing to resolve a name against, so
            // the image is dropped rather than pasted broken (insertImageFiles bails the same way).
            if (!mediaFolderId) continue;
            const { width, height } = box;
            const index = plan.partials.length;
            const crossMount = needsReUpload(item.sourceParentId, mediaFolderId);
            plan.partials.push({
                type: 'image',
                ...placeAt(width, height),
                width,
                height,
                angle,
                // Added at once under a pending name. The hook swaps the real name in once the upload lands.
                mediaName: crossMount ? `${PENDING_PREFIX}${crypto.randomUUID()}` : item.mediaName,
            });
            if (crossMount) plan.crossMount.push({ index, item });
            continue;
        }
        // A chart keeps its parts as they came, its font included, and its look as the element's own fields.
        if (item.type === 'chart') {
            const { width, height } = box;
            plan.partials.push({
                type: 'chart',
                ...placeAt(width, height),
                width,
                height,
                angle,
                ...newChartSpecParts(item.parts),
                ...item.look,
            });
            continue;
        }
        // An empty text item carries nothing to paste.
        if (item.type !== 'text' || !clipboardTextItemHasContent(item)) continue;
        const typo = item.typography ?? {};
        const fontFamily = typo.fontFamily ?? styleDefaults.fontFamily;
        // The item's size is in pt. Any web page can write the item, so only a finite number is a size.
        const fontSize =
            typo.fontSize !== undefined && Number.isFinite(typo.fontSize)
                ? canvasPtToPx(typo.fontSize, slideWidth)
                : styleDefaults.fontSize;
        const typography = readClipboardTypography(typo);
        const font = {
            fontSize,
            fontFamily,
            fontWeight: typography.fontWeight,
            letterSpacing: typography.letterSpacing,
        };
        const measured = measureVectorText(item.text, font);
        const width = textBoxWidth(measured.width);
        plan.measuredText.push({ index: plan.partials.length, text: item.text, font, width });
        plan.partials.push({
            type: 'rectangle',
            autoFit: true,
            ...placeAt(width, measured.height),
            width,
            height: measured.height,
            angle,
            html: textToParagraphHtml(item.text),
            fontSize,
            fontFamily,
            // A color the item doesn't name is left to the host's table, as for any new text box.
            ...(typo.color === undefined ? {} : { color: typo.color }),
            ...typography,
        });
    }
    return plan;
}

// Plain text becomes one text box centered on `anchor`, one paragraph per line. It is measured in the host's text box
// defaults, and the partial names no font, so the writer creates the box from the same table.
export function planTextPaste(
    text: string,
    textAlign: TextAlign,
    anchor: Point,
    styleDefaults: StyleDefaults,
): PastePlan {
    const { fontSize, fontFamily, fontWeight, letterSpacing } = textBoxDefaults(styleDefaults);
    const font = { fontSize, fontFamily, fontWeight, letterSpacing };
    const measured = measureVectorText(text, font);
    const width = textBoxWidth(measured.width);
    const { height } = measured;
    return {
        ...emptyPastePlan(),
        partials: [
            {
                type: 'rectangle',
                autoFit: true,
                x: anchor.x - width / 2,
                y: anchor.y - height / 2,
                width,
                height,
                angle: 0,
                html: textToParagraphHtml(text),
                textAlign,
            },
        ],
        measuredText: [{ index: 0, text, font, width }],
    };
}

// A text box as wide as its measured text, rounded up to whole px. The browser rounds the text's width up and the
// box's down as it lays them out, so a box even a hair narrower than its text wraps the last word.
export function textBoxWidth(measured: number): number {
    return Math.ceil(measured);
}

// The whole stored record minus what the writer allocates: the id, the index and the seed. A copy takes its own jitter
// and starts with no comments, as a duplicate does. Any web page can write our MIME, so the `html` of a text box or a
// shape passes the LightEditor allowlist before it reaches the doc. It is the sanitizer the layer runs, so nothing
// hostile is ever stored.
function pastePartial(el: VectorElement): NewVectorElement {
    const { id, index, seed, ...rest } = el;
    const partial: NewVectorElement = { ...rest, commentCardIds: '' };
    if ('html' in el) partial.html = sanitizeToLightEditorHtml(el.html);
    return partial;
}
