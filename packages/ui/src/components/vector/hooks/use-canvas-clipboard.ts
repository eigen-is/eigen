// The canvas's clipboard: the ⌘C, ⌘X and ⌘V document listeners, the menu's copy, cut and paste, and the order a paste
// tries its flavors in: our items, then our SVG's embedded items, then OS files, then plain text. buildSelectionData
// builds what a copy writes, and the paste planners decide what a paste adds. This hook owns the events and the writes.

import { onMutationError } from '@workspace/lib/api-error';
import {
    classifyPaste,
    EIGEN_CLIPBOARD_RENDER_ATTR,
    extractClipboardSvgMetadata,
    inlineClipboardSvgMedia,
    readEigenClipboardAsync,
    reUploadImage,
    svgToImageDataUri,
    svgToImageFile,
    writeEigenClipboard,
    writeEigenClipboardAsync,
} from '@workspace/lib/clipboard';
import { textToParagraphHtml } from '@workspace/lib/html';
import { htmlToPlainText, readDominantTextAlign } from '@workspace/lib/html-dom';
import type { EigenClipboardImageItem, EigenClipboardItem } from '@workspace/lib/types/clipboard';
import type { DrivePath } from '@workspace/lib/types/drive';
import type {
    NewVectorElement,
    Point,
    StyleDefaults,
    VectorElement,
    VectorElementPatch,
    VectorMeta,
} from '@workspace/lib/vector';
import {
    isTextBox,
    pasteAnchorOffset,
    readElementsClipboardItem,
    reanchorElements,
    textBoxFitHeight,
} from '@workspace/lib/vector';
import { sealed } from '@workspace/ui/components/properties-panel';
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type * as Y from 'yjs';
import { isTypingTarget } from '../../../hooks/is-typing-target';
import { downloadCanvasImage } from '../canvas-image';
import { isVectorFontLoaded, measureLoadedVectorText } from '../text-measure';
import { remapPastedArrows } from '../tools/binding';
import { buildSelectionData, selectionPlainText } from '../tools/clipboard';
import type { PastePlan } from '../tools/paste-elements';
import { planElementsPaste, planForeignPaste, planTextPaste, textBoxWidth } from '../tools/paste-elements';
import { deleteSelection } from './selection-ops';

// How many images from another media folder upload again at once. Any web page can write the payload, so a paste must
// not start hundreds of fetches and uploads together. A handful keeps a normal paste of several images quick.
const REUPLOAD_CONCURRENCY = 4;

// The fields of a text box that its measured width depends on.
const FONT_FIELDS = ['fontSize', 'fontFamily', 'fontWeight', 'letterSpacing'] as const;

type CanvasClipboardParams = {
    canEdit: boolean;
    // Whether a text editor owns the keyboard. The listeners are bound once, so they read it from a ref. The label
    // editor and the in-place editor keep the native clipboard while they are open.
    textEditingRef: { current: boolean };
    // The canvas surface. A text run selected outside it, such as in a comment, owns copy and cut.
    containerRef: { current: HTMLDivElement | null };
    viewport: 'infinite' | 'frame';
    frameId: string;
    // The host's table for a new element, such as Excalifont 20 in a drawing. A pasted text box is a new element like
    // any other, so it is measured and created with this table. Otherwise ⌘V and the Text tool would disagree.
    styleDefaults: StyleDefaults;
    // The scene in z-order, its background and the selection: what a copy writes.
    ordered: readonly VectorElement[];
    meta: VectorMeta;
    selectedIds: readonly string[];
    setSelectedIds: (ids: string[]) => void;
    // The canvas's writers. Its addElements stamps the active frame over the caller's fields, so a pasted element lands
    // in the frame it is pasted into, never the one it was copied from.
    addElements: (partials: NewVectorElement[]) => string[];
    updateElements: (patches: { id: string; fields: VectorElementPatch }[]) => void;
    updateElementsUntracked: (patches: { id: string; fields: VectorElementPatch }[]) => void;
    deleteElements: (ids: string[]) => void;
    deleteElementsUntracked: (ids: string[]) => void;
    undoManager: Y.UndoManager | null;
    viewportCenterScene: () => Point;
    // OS files on the clipboard go through the canvas's own image insert.
    insertImageFiles: (files: File[], anchor: Point) => Promise<void>;
    mediaFolderId: string | null;
    resolveMediaPath: (name: string) => DrivePath | undefined;
    resolveMediaUrl: (name: string) => string | null;
    uploadFile: (args: { parentId: string; file: File }) => Promise<DrivePath | null>;
};

export function useCanvasClipboard(params: CanvasClipboardParams) {
    const { canEdit, textEditingRef, containerRef, viewport, frameId, styleDefaults, ordered, meta } = params;
    const { selectedIds, setSelectedIds, addElements, updateElements, updateElementsUntracked } = params;
    const { deleteElements, deleteElementsUntracked, undoManager, viewportCenterScene } = params;
    const { insertImageFiles, mediaFolderId, resolveMediaPath, resolveMediaUrl, uploadFile } = params;

    // The latest rendered scene, for a heal that lands after the render that started it. It can trail the Y.Doc for a
    // moment, and the next render brings it up to date.
    const orderedRef = useRef(ordered);
    orderedRef.current = ordered;

    // A deck converts a text item's size at its own width, and a drawing at 96 dpi.
    const slideWidth = viewport === 'frame' ? meta.slideWidth : undefined;
    const buildData = useCallback(
        () => buildSelectionData(ordered, selectedIds, meta, frameId, resolveMediaPath, slideWidth),
        [ordered, selectedIds, meta, frameId, resolveMediaPath, slideWidth],
    );
    const plainText = useCallback(() => selectionPlainText(ordered, selectedIds), [ordered, selectedIds]);

    // Our `svg` references images by name, so it draws them blank outside Eigen. The menu's copy alone also writes an
    // `<img>` of that SVG with its images inlined as data URIs, so a plain editor in another app pastes a picture. The
    // bytes come from the media resolver, and past the size cap, or when inlining fails, the flavor is skipped. ⌘C
    // writes no bytes, because a copy event can't wait for a fetch.
    const fetchMediaBlob = useCallback(
        async (name: string): Promise<Blob | null> => {
            const url = resolveMediaUrl(name);
            if (!url) return null;
            try {
                const res = await fetch(url, { credentials: 'include' });
                return res.ok ? await res.blob() : null;
            } catch {
                return null;
            }
        },
        [resolveMediaUrl],
    );
    const foreignImgHtml = useCallback(
        async (svg: string | undefined): Promise<string | undefined> => {
            if (!svg) return undefined;
            const inlined = await inlineClipboardSvgMedia(svg, fetchMediaBlob);
            // The mark makes hasRichHtmlBeyondMarker ignore the img. Otherwise a copy of shapes reads as rich HTML, and
            // a host without media would store the base64 SVG as a figure.
            return inlined
                ? `<img ${EIGEN_CLIPBOARD_RENDER_ATTR}="" src="${await svgToImageDataUri(inlined)}">`
                : undefined;
        },
        [fetchMediaBlob],
    );

    // One paste is one undo step: every add and the remap of the arrows' bindings are sealed together. Then the images
    // from another media folder upload untracked, and the text boxes are measured again once their slices load.
    const commitPaste = useCallback(
        (plan: PastePlan): boolean => {
            if (!plan.partials.length) return false;
            const ids = sealed(undoManager, () => {
                const added = addElements(plan.partials);
                const remap = remapPastedArrows(plan.arrowRemaps, plan.cloneIds, added);
                if (remap.length) updateElements(remap);
                return added;
            });
            if (!ids.length) return false;
            setSelectedIds(ids);

            // A box measured before the slices of its text loaded holds the fallback's size, so it is measured again
            // once they have. Every box is written in one transaction once all the loads settle, because each write
            // reads the whole scene again. The write is untracked, so the paste stays one undo step, and ⌘Z removes the
            // box whole. A box whose text, font or width changed since the paste has been edited or resized, and that
            // edit owns its size, so it is left alone. The heal writes the height too, because the fit only grows: a
            // fallback that wrapped the text grew the box. The height is what textBoxFitHeight asks of a box with none
            // yet: the text plus the inset and the border.
            const unloaded = plan.measuredText.filter(({ text, font }) => !isVectorFontLoaded(text, font));
            const measures = Promise.allSettled(unloaded.map(({ text, font }) => measureLoadedVectorText(text, font)));
            measures.then((results) => {
                const byId = new Map(orderedRef.current.map((el) => [el.id, el]));
                const patches: { id: string; fields: VectorElementPatch }[] = [];
                for (const [i, { index, text, font, width }] of unloaded.entries()) {
                    const result = results[i];
                    const el = byId.get(ids[index]);
                    if (result.status === 'rejected' || !el || !isTextBox(el)) continue;
                    if (el.html !== textToParagraphHtml(text) || el.width !== width) continue;
                    if (!FONT_FIELDS.every((field) => el[field] === font[field])) continue;
                    const healed = {
                        width: textBoxWidth(result.value.width),
                        height: textBoxFitHeight({ ...el, height: 0 }, result.value.height) ?? el.height,
                    };
                    if (healed.width !== el.width || healed.height !== el.height) {
                        patches.push({ id: el.id, fields: healed });
                    }
                }
                if (patches.length > 0) updateElementsUntracked(patches);
            });

            // An image from another media folder is fetched from its source and uploaded into ours. Its pending name
            // is then swapped for the real one, or the element is dropped when the upload fails. A forged payload can
            // carry hundreds of images, so a few upload at a time.
            const pending = [...plan.crossMount];
            const drain = async (): Promise<void> => {
                const next = pending.shift();
                if (!next) return;
                const id = ids[next.index];
                if (id && mediaFolderId) {
                    const result = await reUploadImage(
                        next.item.sourcePathId,
                        next.item.sourceOwnerId,
                        next.item.sourceMountId,
                        mediaFolderId,
                        uploadFile,
                        next.item.mediaName,
                    ).catch(() => null);
                    // Untracked, so the swap is no undo step of its own and one ⌘Z takes back the whole paste. A redo
                    // adds the element back under its pending name, as every optimistic insert does.
                    if (result) updateElementsUntracked([{ id, fields: { mediaName: result.mediaName } }]);
                    else deleteElementsUntracked([id]);
                }
                return drain();
            };
            for (let i = 0; i < Math.min(REUPLOAD_CONCURRENCY, pending.length); i += 1) drain().catch(() => {});
            return true;
        },
        [
            addElements,
            updateElements,
            setSelectedIds,
            undoManager,
            mediaFolderId,
            uploadFile,
            updateElementsUntracked,
            deleteElementsUntracked,
        ],
    );

    // Our own payload restores its elements: whole stored records through the reader, moved as a set. Its image items
    // only say where each image's bytes are. A payload without an elements item pastes another app's items.
    //
    // Returns whether anything was placed. A payload can hold items and still place nothing, such as when the reader
    // drops every item as forged, or when images have no media folder to upload into. The caller must not claim the
    // event then, because the later flavors and the container's file handler still deserve their turn.
    const pasteEigenItems = useCallback(
        (items: EigenClipboardItem[]): boolean => {
            if (!items.length) return false;
            const native = readElementsClipboardItem(items);
            if (!native?.elements.length) {
                return commitPaste(
                    planForeignPaste(items, viewportCenterScene(), mediaFolderId, styleDefaults, slideWidth),
                );
            }
            const { dx, dy } = pasteAnchorOffset(
                native.elements,
                native.sourceFrameId,
                viewport === 'frame' ? frameId : '',
                viewportCenterScene(),
            );
            const imageItems = items.filter((i): i is EigenClipboardImageItem => i.type === 'image');
            return commitPaste(planElementsPaste(reanchorElements(native.elements, dx, dy), imageItems, mediaFolderId));
        },
        [commitPaste, viewport, frameId, viewportCenterScene, mediaFolderId, styleDefaults, slideWidth],
    );

    // An SVG of ours carries its items in a `<metadata>` block, and pastes as those elements. Another app's drawing
    // returns false, and the caller inserts it as an image. ⌘V and a file drop share this, so dropping an SVG we
    // exported restores its elements as pasting it does.
    const pasteSvgText = useCallback(
        (svg: string): boolean => {
            const restored = extractClipboardSvgMetadata(svg);
            return restored ? pasteEigenItems(restored.items) : false;
        },
        [pasteEigenItems],
    );

    // Text with no payload of ours and no OS files becomes one text box at the viewport center: the plain text, or the
    // text of pasted HTML. Its alignment comes from the HTML's block text-align. ⌘V and the menu share this. It returns
    // whether it pasted, so ⌘V claims the event only for a real paste.
    const pasteNonEigenText = useCallback(
        (html: string, plain: string): boolean => {
            const content = plain || htmlToPlainText(html);
            if (!content.trim()) return false;
            const textAlign = (html && readDominantTextAlign(html)) || 'left';
            commitPaste(planTextPaste(content, textAlign, viewportCenterScene(), styleDefaults));
            return true;
        },
        [commitPaste, viewportCenterScene, styleDefaults],
    );

    // ⌘C, ⌘X and ⌘V listen for the document's clipboard events, because only a native event can write our MIME and read
    // the clipboard at once. They stand down while a text field has focus, so the label editor and a comment composer
    // keep the native clipboard. Our items are tried first. A paste of anything else falls through, in the capture
    // phase, to the container's file paste target. The three listeners bind once and read the live scene and writers
    // through this ref, so a canvas render, such as a drag preview, never rebinds them.
    const handlers = {
        canEdit,
        selectedIds,
        buildData,
        plainText,
        pasteEigenItems,
        pasteSvgText,
        pasteNonEigenText,
        insertImageFiles,
        mediaFolderId,
        viewportCenterScene,
        deleteElements,
        setSelectedIds,
        undoManager,
    };
    const live = useRef(handlers);
    live.current = handlers;

    useEffect(() => {
        const blocked = () => isTypingTarget() || !live.current.canEdit || textEditingRef.current;
        // A text run selected outside the canvas owns copy and cut: the user is copying that text, and writing the
        // elements instead would take the clipboard from them with nothing on screen to explain it. Inside the canvas
        // there is no such text, because the in-place editor is `blocked()` above.
        const textSelectedOutside = () => outsideTextSelection(containerRef.current) !== null;
        const onCopyEvent = (e: ClipboardEvent) => {
            const { selectedIds, buildData, plainText } = live.current;
            if (blocked() || textSelectedOutside() || selectedIds.length === 0) return;
            const { data } = buildData();
            if (!data.items.length) return;
            e.preventDefault();
            writeEigenClipboard(e, data, plainText());
        };
        const onCutEvent = (e: ClipboardEvent) => {
            const { selectedIds, buildData, plainText, deleteElements, setSelectedIds, undoManager } = live.current;
            if (blocked() || textSelectedOutside() || selectedIds.length === 0) return;
            const { data, serializedIds, pendingImages } = buildData();
            if (!data.items.length) {
                // A selection of only images still uploading copies nothing, so nothing may be deleted. The event is
                // claimed anyway to say why, because a cut that silently did nothing looks like one that worked.
                if (!pendingImages) return;
                e.preventDefault();
                warnPartialCut(pendingImages);
                return;
            }
            e.preventDefault();
            writeEigenClipboard(e, data, plainText());
            // Only what the payload carries is deleted. An image whose media path doesn't resolve yet was left out of
            // the copy, so cutting it would destroy its one copy, and undo is no substitute for not losing it. The
            // delete is one undo step.
            deleteSelection(serializedIds, deleteElements, setSelectedIds, undoManager);
            warnPartialCut(pendingImages);
        };
        const onPasteEvent = (e: ClipboardEvent) => {
            const { pasteEigenItems, pasteSvgText, pasteNonEigenText } = live.current;
            const { insertImageFiles, mediaFolderId, viewportCenterScene } = live.current;
            if (blocked()) return;
            const cd = e.clipboardData;
            if (!cd) return;
            const paste = classifyPaste(cd);
            const claim = () => {
                e.preventDefault();
                e.stopPropagation();
            };
            // Our items go before the SVG, so a paste between canvases restores the elements rather than one flat
            // image. The event is claimed only when something was placed, so a payload that places nothing leaves the
            // flavors below their turn.
            if (paste.eigen && pasteEigenItems(paste.eigen.items)) {
                claim();
                return;
            }
            // An SVG on its own: one of ours restores its elements, and any other is inserted as an image.
            if (paste.svg) {
                if (pasteSvgText(paste.svg.svg)) {
                    claim();
                    return;
                }
                // Another app's SVG lands as an image, which needs a media folder to upload into. Without one
                // insertImageFiles places nothing, so the paste is claimed only when there is one, and the text
                // below gets its turn otherwise.
                if (mediaFolderId) {
                    claim();
                    void insertImageFiles([svgToImageFile(paste.svg.svg)], viewportCenterScene());
                    return;
                }
            }
            // Nothing was placed yet. OS files fall through to the container's file paste target.
            if (paste.files.length > 0) return;
            // Plain text, or the text of pasted HTML, becomes a text box. The event is claimed only when it did.
            if (pasteNonEigenText(paste.html, paste.text)) {
                claim();
                return;
            }
            // A payload of ours was there and nothing in it could be placed. Without this ⌘V would do nothing and say
            // nothing.
            if (paste.eigen) toast.info('Nothing in this paste could be placed on the canvas');
        };
        document.addEventListener('copy', onCopyEvent);
        document.addEventListener('cut', onCutEvent);
        document.addEventListener('paste', onPasteEvent, true);
        return () => {
            document.removeEventListener('copy', onCopyEvent);
            document.removeEventListener('cut', onCutEvent);
            document.removeEventListener('paste', onPasteEvent, true);
        };
    }, [textEditingRef, containerRef]);

    // The menu's clipboard rows. They have no clipboard event, so copy and cut go through the async writer and paste
    // through the async reader, which gives no OS files. They build and place through the same code as the keys.
    const onMenuCopy = () => {
        const { data } = buildData();
        if (!data.items.length) return;
        // The inliner's promise goes straight into the writer, because Safari and Firefox let a clipboard write start
        // only inside the user's gesture, not once the media fetch resolves.
        void writeEigenClipboardAsync(data, plainText(), foreignImgHtml(data.svg)).catch(() => {});
    };
    const onMenuCut = () => {
        if (!canEdit) return;
        const { data, serializedIds, pendingImages } = buildData();
        if (!data.items.length) {
            // Nothing was copied, as in the ⌘X case, but there is no event to claim.
            warnPartialCut(pendingImages);
            return;
        }
        // The delete waits for the write to land, because a denied write must not destroy the selection: it would then
        // exist nowhere but the undo stack. It deletes only the ids the payload carries, as ⌘X does.
        void writeEigenClipboardAsync(data, plainText(), foreignImgHtml(data.svg))
            .then(() => {
                deleteSelection(serializedIds, deleteElements, setSelectedIds, undoManager);
                warnPartialCut(pendingImages);
            })
            .catch(() => {});
    };
    const onMenuPaste = () => {
        // ⌘V asks canEdit, and so does this. The menu opens only when the user can edit, but a write must never
        // depend on a caller remembering that.
        if (!canEdit) return;
        (async () => {
            const data = await readEigenClipboardAsync();
            if (data && pasteEigenItems(data.items)) return;
            // Nothing was placed yet, so this tries the flavors in ⌘V's order, through the same classifier: an SVG
            // restores our elements or lands as an image, and anything else becomes a text box. Pasting OS files needs
            // ⌘V, because the async API gives no File objects.
            let html = '';
            let text = '';
            for (const clip of await navigator.clipboard.read()) {
                if (!html && clip.types.includes('text/html')) html = await (await clip.getType('text/html')).text();
                if (!text && clip.types.includes('text/plain')) text = await (await clip.getType('text/plain')).text();
            }
            const transfer = new DataTransfer();
            if (html) transfer.setData('text/html', html);
            if (text) transfer.setData('text/plain', text);
            const paste = classifyPaste(transfer);
            if (paste.svg) {
                if (pasteSvgText(paste.svg.svg)) return;
                if (mediaFolderId) {
                    await insertImageFiles([svgToImageFile(paste.svg.svg)], viewportCenterScene());
                    return;
                }
            }
            if (pasteNonEigenText(paste.html, paste.text)) return;
            // A payload of ours was there and nothing in it could be placed: ⌘V's toast, for the same reason.
            if (data) toast.info('Nothing in this paste could be placed on the canvas');
        })().catch(() => {
            /* clipboard read denied or unavailable */
        });
    };

    // Download image: the elements as the browser draws them, on the drawing's background when it is the whole drawing.
    const downloadImage = useCallback(
        (name: string, elements: VectorElement[], background?: string) => {
            downloadCanvasImage(elements, { name, background, fetchMedia: fetchMediaBlob }).catch(onMutationError);
        },
        [fetchMediaBlob],
    );

    return { onMenuCopy, onMenuCut, onMenuPaste, pasteSvgText, downloadImage };
}

// The canvas drops a text run selected outside it when the pointer lands on the canvas. The surface is `select-none`,
// and the in-place editor swallows its own pointerdown, so nothing else collapses a selection made in, say, a comment.
// It would survive the click that selects an element and keep ⌘C and ⌘X, which would copy that text and cut nothing.
export function dropOutsideTextSelection(container: HTMLElement | null): void {
    outsideTextSelection(container)?.removeAllRanges();
}

// A cut deletes only what the clipboard carries, so an image that could not be copied stays put. The user is told,
// or a cut of most of the selection would look like a cut of all of it, and a cut of that image alone like nothing.
function warnPartialCut(pendingImages: number) {
    if (pendingImages <= 0) return;
    toast.info(
        pendingImages === 1
            ? 'One image is still uploading, so it stayed in the drawing'
            : `${pendingImages} images are still uploading, so they stayed in the drawing`,
    );
}

// A text selection outside the canvas that is more than a caret, if there is one: the run a copy would carry.
function outsideTextSelection(container: HTMLElement | null): Selection | null {
    const selection = container?.ownerDocument.getSelection() ?? null;
    if (!selection || selection.isCollapsed || selection.toString().trim() === '') return null;
    const node = selection.anchorNode;
    return node && container?.contains(node) ? null : selection;
}
