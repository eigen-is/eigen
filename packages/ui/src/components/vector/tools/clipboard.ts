// Builds what a canvas copy puts on the clipboard. A selection travels as one typed `elements` item of whole stored
// records, so a paste into a canvas restores exactly what was copied. Beside it go the image, text and chart items that
// other apps read, and a self-contained SVG for apps that read none of them. It runs on every copy and cut, and it is
// pure, so the canvas only calls it.

import {
    buildChartClipboardItem,
    buildImageClipboardItem,
    buildTextClipboardItem,
    CLIPBOARD_SVG_MAX_BYTES,
    CLIPBOARD_SVG_MAX_ELEMENTS,
    embedClipboardSvgMetadata,
} from '@workspace/lib/clipboard';
import { stripTagsServer } from '@workspace/lib/html';
import { sanitizeToLightEditorHtml } from '@workspace/lib/html-dom';
import type { EigenClipboardData, EigenClipboardItem } from '@workspace/lib/types/clipboard';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { VectorElement, VectorMeta } from '@workspace/lib/vector';
import { buildElementsClipboardItem, canvasPxToPt, eigenMediaHref, isTextBox, sceneToSvg } from '@workspace/lib/vector';

// The whole payload for a selection: the `elements` item for a paste into a canvas, the typed items beside it for
// other apps, and the SVG flavor unless selectionSvg leaves it out. `slideWidth` is a deck's, the scale its text items'
// sizes convert at; a drawing has none.
//
// It also returns the ids it serialized, which are not always the selection. An image whose media path doesn't resolve
// yet, such as a pending upload, has no reference anyone could fetch its bytes from, so it is left out. A cut deletes
// only these ids: deleting an element the copy dropped would lose it, and undo is no substitute for not losing it.
//
// `pendingImages` counts the images left out, which the cut tells the user about. It is not the selection's length
// minus the serialized ids: a selected id that a peer deleted is missing from the payload too, and is nothing to report.
export function buildSelectionData(
    ordered: readonly VectorElement[],
    selectedIds: readonly string[],
    meta: VectorMeta,
    frameId: string,
    resolveMediaPath: (name: string) => DrivePath | undefined,
    slideWidth?: number,
): { data: EigenClipboardData; serializedIds: string[]; pendingImages: number } {
    const selected: VectorElement[] = [];
    let pendingImages = 0;
    for (const el of ordered) {
        if (!selectedIds.includes(el.id)) continue;
        if (el.type === 'image' && !resolveMediaPath(el.mediaName)) {
            pendingImages += 1;
            continue;
        }
        selected.push(el);
    }
    const elementsItem = buildElementsClipboardItem(selected, frameId);
    const items: EigenClipboardItem[] = elementsItem ? [elementsItem] : [];
    items.push(...foreignItems(selected, resolveMediaPath, slideWidth));
    return {
        data: { version: 1, items, svg: selectionSvg(selected, items, meta, resolveMediaPath) },
        serializedIds: selected.map((el) => el.id),
        pendingImages,
    };
}

// The plain text of the selected text boxes, one per line, written as text/plain beside our MIME. A copy of shapes,
// lines or images writes none, so the result is undefined when the selection has no text box.
export function selectionPlainText(
    ordered: readonly VectorElement[],
    selectedIds: readonly string[],
): string | undefined {
    const texts: string[] = [];
    for (const el of ordered) {
        if (!selectedIds.includes(el.id) || !isTextBox(el)) continue;
        const text = stripTagsServer(el.html);
        if (text.length > 0) texts.push(text);
    }
    return texts.length ? texts.join('\n') : undefined;
}

// The items another app reads. Each selected image gives an image item, which a paste into a canvas also uses to find
// the image's bytes by `mediaName`. Each text box gives a text item with its plain text and typography, so it pastes
// styled. Each chart gives a chart item with its data inline, so it pastes live.
function foreignItems(
    selected: readonly VectorElement[],
    resolveMediaPath: (name: string) => DrivePath | undefined,
    slideWidth: number | undefined,
): EigenClipboardItem[] {
    const items: EigenClipboardItem[] = [];
    for (const el of selected) {
        const box = { width: el.width, height: el.height, angle: el.angle };
        if (el.type === 'image') {
            const source = resolveMediaPath(el.mediaName);
            if (source) items.push(buildImageClipboardItem({ mediaName: el.mediaName, source, box }));
        } else if (el.type === 'chart') {
            const item = buildChartClipboardItem({ chart: el, box, look: el });
            if (item) items.push(item);
        } else if (isTextBox(el)) {
            items.push(
                buildTextClipboardItem({
                    text: stripTagsServer(el.html),
                    box,
                    // Every typography field a text box stores, so bold, italic, underline and spacing survive a copy
                    // into a doc. Each one has a reader on the other side.
                    typography: {
                        fontFamily: el.fontFamily,
                        fontSize: canvasPxToPt(el.fontSize, slideWidth),
                        textAlign: el.textAlign,
                        color: el.color,
                        fontWeight: el.fontWeight,
                        fontStyle: el.fontStyle,
                        textDecoration: el.textDecoration,
                        verticalAlign: el.verticalAlign,
                        letterSpacing: el.letterSpacing,
                        lineHeight: el.lineHeight,
                    },
                }),
            );
        }
    }
    return items;
}

// The SVG flavor for a selection, or undefined when it must not be written.
//
// A selection of only text boxes, or only charts, writes none. Other apps read the SVG before the typed items, so such a
// copy would land in a document as a flat picture of itself and its item would never be read. The SVG says nothing
// about a text box or a chart that its item doesn't, so leaving it out makes a text box paste as editable text and a
// chart as a live chart. A big selection writes none either, past the caps: the SVG is the expensive half of a copy,
// and the typed items are the lossless half.
//
// Otherwise it is a self-contained render that carries the items in a `<metadata>` block, so it turns back into
// elements when pasted into a canvas without our MIME. Images are referenced by name, `href="eigen-media:<name>"`, never
// by their bytes, so the copy stays synchronous. The name resolves against the target's own media folder on paste. An
// elbow arrow bound to a shape outside the selection draws straight here, because the render sees the selection alone.
function selectionSvg(
    selected: readonly VectorElement[],
    items: EigenClipboardItem[],
    meta: VectorMeta,
    resolveMediaPath: (name: string) => DrivePath | undefined,
): string | undefined {
    if (selected.length === 0) return undefined;
    if (selected.every(isTextBox) || selected.every((el) => el.type === 'chart')) return undefined;
    if (selected.length > CLIPBOARD_SVG_MAX_ELEMENTS) return undefined;
    // The `html` of a text box or a shape arrives as any peer with write access wrote it. It is sanitized here, as
    // everywhere else that renders it, such as the layer and the paste planner.
    const elements = selected.map((el) => ('html' in el ? { ...el, html: sanitizeToLightEditorHtml(el.html) } : el));
    const svg = embedClipboardSvgMetadata(
        sceneToSvg(
            { elements, frames: [], meta },
            { resolveMedia: (name) => (resolveMediaPath(name) ? eigenMediaHref(name) : null) },
        ),
        { version: 1, items },
    );
    return svg.length > CLIPBOARD_SVG_MAX_BYTES ? undefined : svg;
}
