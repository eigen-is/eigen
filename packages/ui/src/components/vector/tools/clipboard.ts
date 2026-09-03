// Vector clipboard PRODUCER — the selection→payload builder, moved out of canvas-editor.tsx (a self-
// contained pure block) so the canvas stays a dispatcher. A selection rides as ONE typed `elements`
// item (whole stored records, so a canvas→canvas paste restores exactly what was copied), plus the
// per-image and per-rich-text items every other app reads, plus the self-contained SVG flavour. The
// paste CONSUMER is tools/paste-elements.ts.

import { buildImageClipboardItem, buildTextClipboardItem, embedClipboardSvgMetadata } from '@workspace/lib/clipboard';
import { stripTagsServer } from '@workspace/lib/html';
import type { EigenClipboardData, EigenClipboardItem } from '@workspace/lib/types/clipboard';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    buildElementsClipboardItem,
    eigenMediaHref,
    sceneToSvg,
    type TextAlign,
    type VectorElement,
    type VectorMeta,
} from '@workspace/lib/vector';

export function toVectorTextAlign(v: string | undefined): TextAlign {
    return v === 'center' || v === 'right' ? v : 'left';
}

// The items a foreign host reads: an image item per selected image (also the cross-mount re-upload
// manifest a canvas→canvas paste keys on by `mediaName`), and a text item per rich-text box carrying
// the flattened text plus its HTML under `meta.html` (the slides idiom, so a rich host pastes styled).
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
                    typography: {
                        fontFamily: el.fontFamily,
                        fontSize: el.fontSize,
                        textAlign: el.textAlign,
                        color: el.color,
                    },
                    meta: { html: el.html },
                }),
            );
        }
    }
    return items;
}

// The full eigen payload for a selection: the native `elements` item (a canvas→canvas paste) and the
// typed image/text items beside it (every other host) PLUS a self-contained SVG of the same selection
// for hosts that can't place any of them — docs/sheets/slides render it as an image. The SVG carries
// the items in a `<metadata>` block so it round-trips back to native elements if pasted into a canvas
// without the eigen flavour. An image-bearing selection's SVG references its images BY NAME —
// `href="eigen-media:<name>"`, never bytes — so the sync copy path stays byte-free and the ref resolves
// against the target's own media/ on paste (materializeClipboardSvg re-uploads, then the display path
// inlines, see CLIPBOARD.md). A still-pending upload has no portable path, so its element is left out
// of the whole payload: nobody could fetch its bytes.
export function buildSelectionData(
    ordered: VectorElement[],
    selectedIds: string[],
    meta: VectorMeta,
    frameId: string,
    resolveMediaPath: (name: string) => DrivePath | undefined,
): EigenClipboardData {
    const selected = ordered.filter(
        (el) => selectedIds.includes(el.id) && (el.type !== 'image' || resolveMediaPath(el.mediaName)),
    );
    const elementsItem = buildElementsClipboardItem(selected, frameId);
    const items: EigenClipboardItem[] = elementsItem ? [elementsItem] : [];
    items.push(...foreignItems(selected, resolveMediaPath));
    const svg = embedClipboardSvgMetadata(
        sceneToSvg(
            { elements: selected, frames: [], meta },
            { resolveMedia: (name) => (resolveMediaPath(name) ? eigenMediaHref(name) : null) },
        ),
        { version: 1, items },
    );
    return { version: 1, items, svg };
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
