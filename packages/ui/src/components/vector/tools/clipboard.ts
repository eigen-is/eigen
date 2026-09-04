// Vector clipboard PRODUCER — the selection→payload builder, moved out of canvas-editor.tsx (a self-
// contained pure block) so the canvas stays a dispatcher. A selection rides as ONE typed `elements`
// item (whole stored records, so a canvas→canvas paste restores exactly what was copied), plus the
// per-image and per-rich-text items every other app reads, plus the self-contained SVG flavour. The
// paste CONSUMER is tools/paste-elements.ts.

import {
    buildImageClipboardItem,
    buildTextClipboardItem,
    CLIPBOARD_SVG_MAX_BYTES,
    CLIPBOARD_SVG_MAX_ELEMENTS,
    embedClipboardSvgMetadata,
} from '@workspace/lib/clipboard';
import { stripTagsServer } from '@workspace/lib/html';
import type { EigenClipboardData, EigenClipboardItem } from '@workspace/lib/types/clipboard';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    buildElementsClipboardItem,
    eigenMediaHref,
    sceneToSvg,
    type VectorElement,
    type VectorMeta,
} from '@workspace/lib/vector';

// The items a foreign host reads: an image item per selected image (also the cross-mount re-upload
// manifest a canvas→canvas paste keys on by `mediaName`), and a text item per rich-text box carrying
// the flattened text and the box's typography, which is what makes it paste styled.
function foreignItems(
    selected: VectorElement[],
    resolveMediaPath: (name: string) => DrivePath | undefined,
): EigenClipboardItem[] {
    const items: EigenClipboardItem[] = [];
    for (const el of selected) {
        const box = { width: el.width, height: el.height, angle: el.angle };
        if (el.type === 'image') {
            const source = resolveMediaPath(el.mediaName);
            if (source) items.push(buildImageClipboardItem({ mediaName: el.mediaName, source, box }));
        } else if (el.type === 'richtext') {
            items.push(
                buildTextClipboardItem({
                    text: stripTagsServer(el.html),
                    box,
                    // The whole modelled set, not a subset: these are exactly the fields a rich-text box
                    // stores, and dropping six of them was how bold/italic/underline/spacing quietly
                    // stopped surviving a copy into docs. Every one has a consumer (see the type).
                    typography: {
                        fontFamily: el.fontFamily,
                        fontSize: el.fontSize,
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

// The SVG flavour for a selection, or undefined when it must not be written. Two gates:
//
// TEXT-ONLY selections skip it. Every foreign host runs its svg rung BEFORE the typed items, so a
// drawing that is nothing but a rich-text box would land in a document as a flat picture of itself —
// the typed text item and its typography never read. An SVG conveys nothing about a text box
// that the text item doesn't, so not writing it is what makes a copied text box paste as styled,
// editable text.
//
// BIG selections skip it too (see the caps): the SVG is the expensive half of a copy and the typed
// items are the lossless half.
//
// What it is otherwise: a self-contained render carrying the items in a `<metadata>` block, so it
// round-trips back to native elements if pasted into a canvas without the eigen flavour. Images are
// referenced BY NAME — `href="eigen-media:<name>"`, never bytes — so the sync copy path stays byte-free
// and the ref resolves against the target's own media/ on paste (materializeClipboardSvg re-uploads,
// then the display path inlines, see CLIPBOARD.md). An elbow arrow bound to an UNSELECTED shape draws
// straight here: the render sees the selection alone, which is what a copy of the selection is.
function selectionSvg(
    selected: VectorElement[],
    items: EigenClipboardItem[],
    meta: VectorMeta,
    resolveMediaPath: (name: string) => DrivePath | undefined,
): string | undefined {
    if (selected.length === 0 || selected.every((el) => el.type === 'richtext')) return undefined;
    if (selected.length > CLIPBOARD_SVG_MAX_ELEMENTS) return undefined;
    const svg = embedClipboardSvgMetadata(
        sceneToSvg(
            { elements: selected, frames: [], meta },
            { resolveMedia: (name) => (resolveMediaPath(name) ? eigenMediaHref(name) : null) },
        ),
        { version: 1, items },
    );
    return svg.length > CLIPBOARD_SVG_MAX_BYTES ? undefined : svg;
}

// The full eigen payload for a selection: the native `elements` item (a canvas→canvas paste), the typed
// image/text items beside it (every other host) and — unless a gate above says otherwise — the SVG
// flavour for hosts that can place neither.
//
// It returns the ids it ACTUALLY serialized alongside the payload, and they are not always the
// selection: an image whose media path doesn't resolve yet (a still-pending upload, or one whose folder
// listing hasn't refreshed) has no portable reference, so nobody could fetch its bytes and it is left
// out of the whole payload. CUT deletes these ids, never the selection — deleting an element the copy
// silently dropped is data loss, and undo is not a substitute for not losing it.
//
// `pendingImages` counts exactly those dropped images, which is what the cut paths tell the user about.
// It is NOT `selectedIds.length - serializedIds.length`: a selected id that no longer exists in the
// scene (a peer deleted it) is also missing from the payload, and is nothing to report.
export function buildSelectionData(
    ordered: VectorElement[],
    selectedIds: string[],
    meta: VectorMeta,
    frameId: string,
    resolveMediaPath: (name: string) => DrivePath | undefined,
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
    items.push(...foreignItems(selected, resolveMediaPath));
    return {
        data: { version: 1, items, svg: selectionSvg(selected, items, meta, resolveMediaPath) },
        serializedIds: selected.map((el) => el.id),
        pendingImages,
    };
}

// Concatenated plain text of the selected RICH TEXT elements — the only flavor written alongside eigen
// JSON (text copies carry text/plain, image/shape/linear copies carry neither). undefined when the
// selection has no rich-text element.
export function selectionPlainText(ordered: VectorElement[], selectedIds: string[]): string | undefined {
    const texts: string[] = [];
    for (const el of ordered) {
        if (!selectedIds.includes(el.id) || el.type !== 'richtext') continue;
        const text = stripTagsServer(el.html);
        if (text.length > 0) texts.push(text);
    }
    return texts.length ? texts.join('\n') : undefined;
}
