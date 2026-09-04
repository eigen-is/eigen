// The canvas' clipboard: the ⌘C/⌘X/⌘V document listeners, the async menu ops, and the paste ladder
// (eigen items → our SVG's embedded metadata → OS files → plain text). The PRODUCER lives in
// tools/clipboard, the paste DECISIONS in tools/paste-elements; this hook owns the events, the
// transacts and the placement.

import {
    classifyPaste,
    clipboardTextItemHasContent,
    EIGEN_CLIPBOARD_RENDER_ATTR,
    extractClipboardSvgMetadata,
    inlineClipboardSvgMedia,
    needsReUpload,
    readClipboardBox,
    readEigenClipboardAsync,
    reUploadImage,
    svgToImageDataUri,
    svgToImageFile,
    writeEigenClipboard,
    writeEigenClipboardAsync,
} from '@workspace/lib/clipboard';
import { PENDING_PREFIX } from '@workspace/lib/drive';
import { textToParagraphHtml } from '@workspace/lib/html';
import { htmlToPlainText, readDominantTextAlign } from '@workspace/lib/html-dom';
import type { EigenClipboardData, EigenClipboardImageItem, EigenClipboardItem } from '@workspace/lib/types/clipboard';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    DEFAULT_FONT_FAMILY,
    DEFAULT_FONT_SIZE,
    DUPLICATE_OFFSET,
    getElementsBounds,
    IMAGE_CASCADE_OFFSET,
    type Point,
    readElementsClipboardItem,
    reanchorElements,
    type TextAlign,
    type VectorElement,
    type VectorMeta,
} from '@workspace/lib/vector';
import { useCallback, useEffect, useRef } from 'react';
import type * as Y from 'yjs';
import { isTypingTarget } from '../../../hooks/is-typing-target';
import { measureVectorText } from '../text-measure';
import { remapPastedArrows } from '../tools/binding';
import { elementBox } from '../tools/boxes';
import { buildSelectionData, selectionPlainText, toVectorTextAlign } from '../tools/clipboard';
import { type PastePlan, planElementsPaste } from '../tools/paste-elements';
import { deleteSelection } from './selection-ops';
import type { NewVectorElement, VectorElementPatch } from './use-canvas-doc';

type CanvasClipboardParams = {
    canEdit: boolean;
    // Read from listeners bound once, so the live "a text surface owns the keyboard" answer rides a
    // ref: the overlay and the in-place editor keep native clipboard while they are open.
    textEditingRef: { current: boolean };
    viewport: 'infinite' | 'frame';
    frameId: string;
    // The scene in z-order, its background, and the selection — what a copy serializes.
    ordered: VectorElement[];
    meta: VectorMeta;
    selectedIds: string[];
    setSelectedIds: (ids: string[]) => void;
    // Frame-stamped writers (the canvas wraps them in homeToFrame), so a pasted element lands in the
    // frame being pasted INTO, never the one it was copied from.
    addElement: (partial: NewVectorElement) => string | undefined;
    addElements: (partials: NewVectorElement[]) => string[];
    updateElements: (patches: { id: string; fields: VectorElementPatch }[]) => void;
    updateElementUntracked: (id: string, fields: VectorElementPatch) => void;
    deleteElements: (ids: string[]) => void;
    deleteElementsUntracked: (ids: string[]) => void;
    undoManager: Y.UndoManager | null;
    viewportCenterScene: () => Point;
    // OS files on the clipboard go through the canvas' own image-insert path.
    insertImageFiles: (files: File[], anchor: Point) => Promise<void>;
    mediaFolderId: string | null;
    resolveMediaPath: (name: string) => DrivePath | undefined;
    resolveMediaUrl: (name: string) => string | null;
    uploadFile: (args: { parentId: string; file: File }) => Promise<DrivePath | null>;
};

export function useCanvasClipboard(params: CanvasClipboardParams) {
    const { canEdit, textEditingRef, viewport, frameId, ordered, meta, selectedIds, setSelectedIds } = params;
    const { addElement, addElements, updateElements, updateElementUntracked } = params;
    const { deleteElements, deleteElementsUntracked, undoManager } = params;
    const { viewportCenterScene, insertImageFiles, mediaFolderId } = params;
    const { resolveMediaPath, resolveMediaUrl, uploadFile } = params;

    // The clipboard PRODUCER (the native elements item, the typed image/text items and the
    // self-contained SVG flavour) + the plain-text flavor live in ../tools/clipboard; this calls them
    // with the live z-order, selection, background, home frame and path resolver.
    const buildData = useCallback(
        (): EigenClipboardData => buildSelectionData(ordered, selectedIds, meta, frameId, resolveMediaPath),
        [ordered, selectedIds, meta, frameId, resolveMediaPath],
    );
    const plainText = useCallback(() => selectionPlainText(ordered, selectedIds), [ordered, selectedIds]);

    // The eigen `svg` field references images BY NAME and renders blank outside eigen's server-side
    // inliner. For the async menu-copy path only, build a foreign-visible `<img src="data:svg…">` whose
    // images are inlined as base64 data URIs, so a plain contenteditable pastes the drawing as an image.
    // Bytes come from the credentialed media resolver; over the soft cap (or on inline failure) we skip
    // the flavour and write today's payload. The sync ⌘C path stays byte-free (a copy event can't fetch).
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
            // Mark the img so hasRichHtmlBeyondMarker ignores it — else a shape-only vector copy reads
            // as rich HTML and a non-media host persists the base64 SVG as a figure.
            return inlined
                ? `<img ${EIGEN_CLIPBOARD_RENDER_ATTR}="" src="${await svgToImageDataUri(inlined)}">`
                : undefined;
        },
        [fetchMediaBlob],
    );

    // Where a pasted set lands. Coordinates on the wire are the stored ones, so "in place" is literally
    // what was copied; the other two cases translate the set as a whole.
    const pasteOffset = useCallback(
        (elements: VectorElement[], sourceFrameId: string): { dx: number; dy: number } => {
            const home = viewport === 'frame' ? frameId : '';
            if (viewport === 'frame' && sourceFrameId === home) return { dx: DUPLICATE_OFFSET, dy: DUPLICATE_OFFSET };
            if (viewport === 'frame' && sourceFrameId !== '') return { dx: 0, dy: 0 }; // another frame ⇒ in place
            const anchor = viewportCenterScene();
            const bounds = getElementsBounds(elements.map(elementBox));
            return { dx: anchor.x - (bounds.minX + bounds.maxX) / 2, dy: anchor.y - (bounds.minY + bounds.maxY) / 2 };
        },
        [viewport, frameId, viewportCenterScene],
    );

    // A payload with no native elements item: another app's images and text. Each lands centred on the
    // viewport, cascading so a multi-item paste stays visible. An image sizes from the TYPED wire box
    // (authoritative), text re-measures LOCALLY (a wire size is never written onto text).
    const planForeignPaste = useCallback(
        (items: EigenClipboardItem[]): PastePlan => {
            const anchor = viewportCenterScene();
            const plan: PastePlan = { partials: [], cloneIds: new Map(), arrowRemaps: [], crossMount: [] };
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
                        // Optimistic add with a pending name; the real name swaps in a late transact.
                        mediaName: crossMount ? `${PENDING_PREFIX}${crypto.randomUUID()}` : item.mediaName,
                    });
                    if (crossMount) plan.crossMount.push({ index, item });
                    continue;
                }
                // An empty text item is a foreign contentless carrier — skip it.
                if (item.type !== 'text' || !clipboardTextItemHasContent(item)) continue;
                const typo = item.typography ?? {};
                const fontFamily = typo.fontFamily ?? DEFAULT_FONT_FAMILY;
                const fontSize = typo.fontSize ?? DEFAULT_FONT_SIZE;
                const { width, height } = measureVectorText(item.text, fontSize, fontFamily);
                plan.partials.push({
                    type: 'richtext',
                    ...placeAt(width, height),
                    width,
                    height,
                    angle,
                    html: textToParagraphHtml(item.text),
                    fontSize,
                    fontFamily,
                    textAlign: toVectorTextAlign(typo.textAlign),
                    color: typo.color,
                });
            }
            return plan;
        },
        [viewportCenterScene, mediaFolderId],
    );

    // One paste = one undo step: every ADD in one transact, the arrow-binding remap inside the same
    // capture window (no stopCapturing between them), then the cross-mount images resolve untracked.
    const commitPaste = useCallback(
        (plan: PastePlan) => {
            if (!plan.partials.length) return;
            undoManager?.stopCapturing();
            const ids = addElements(plan.partials);
            const remap = remapPastedArrows(plan.arrowRemaps, plan.cloneIds, ids);
            if (remap.length) updateElements(remap);
            undoManager?.stopCapturing();
            if (!ids.length) return;
            setSelectedIds(ids);

            // Cross-mount images: fetch from source, re-upload into our media/, swap the pending name
            // (late transact) or drop the element on failure — the shared optimistic-insert idiom.
            for (const { index, item } of plan.crossMount) {
                const id = ids[index];
                if (!id || !mediaFolderId) continue;
                reUploadImage(
                    item.sourcePathId,
                    item.sourceOwnerId,
                    item.sourceMountId,
                    mediaFolderId,
                    uploadFile,
                    item.mediaName,
                )
                    .then((result) => {
                        if (!result) {
                            deleteElementsUntracked([id]);
                            return;
                        }
                        // Untracked: this technical swap is NOT its own undo step, so the whole
                        // cross-mount paste is a single ⌘Z (reverts the insert; peers converge via its
                        // inverse). Redo re-adds the element at its recorded pending name, the accepted
                        // edge of every optimistic insert.
                        updateElementUntracked(id, { mediaName: result.mediaName });
                    })
                    .catch(() => {});
            }
        },
        [
            addElements,
            updateElements,
            setSelectedIds,
            undoManager,
            mediaFolderId,
            uploadFile,
            updateElementUntracked,
            deleteElementsUntracked,
        ],
    );

    // Element clipboard CONSUMER. Our own payload restores NATIVE elements — whole stored records
    // through the reader, re-anchored as a set — and its image items are only the re-upload manifest.
    // A foreign payload falls back to the cross-app items.
    const pasteEigenItems = useCallback(
        (items: EigenClipboardItem[]) => {
            if (!items.length) return;
            const native = readElementsClipboardItem(items);
            if (!native?.elements.length) {
                commitPaste(planForeignPaste(items));
                return;
            }
            const { dx, dy } = pasteOffset(native.elements, native.sourceFrameId);
            const imageItems = items.filter((i): i is EigenClipboardImageItem => i.type === 'image');
            commitPaste(planElementsPaste(reanchorElements(native.elements, dx, dy), imageItems, mediaFolderId));
        },
        [commitPaste, planForeignPaste, pasteOffset, mediaFolderId],
    );

    // Plain-text paste (no eigen payload, no OS files) → ONE rich-text box at the viewport centre, with
    // default typography and a locally-measured box (the pasteEigenItems text idiom). Multi-line text is
    // preserved — textToParagraphHtml keeps one paragraph per line. One sealed undo step.
    const pasteTextElement = useCallback(
        (text: string, textAlign: TextAlign = 'left') => {
            const anchor = viewportCenterScene();
            const { width: w, height: h } = measureVectorText(text, DEFAULT_FONT_SIZE, DEFAULT_FONT_FAMILY);
            undoManager?.stopCapturing();
            const id = addElement({
                type: 'richtext',
                x: anchor.x - w / 2,
                y: anchor.y - h / 2,
                width: w,
                height: h,
                angle: 0,
                html: textToParagraphHtml(text),
                fontSize: DEFAULT_FONT_SIZE,
                fontFamily: DEFAULT_FONT_FAMILY,
                textAlign,
            });
            undoManager?.stopCapturing();
            if (id) setSelectedIds([id]);
        },
        [viewportCenterScene, addElement, setSelectedIds, undoManager],
    );

    // Non-eigen text paste (the keyboard fallthrough and the async menu path share this policy): plain
    // text, or the flattened text of pasted HTML, becomes one rich-text box. Prose alignment rides in
    // text/html as a block text-align; carry it through toVectorTextAlign (justify→left). Returns true
    // when it consumed content so the keyboard handler can gate its preventDefault on a real paste.
    const pasteNonEigenText = useCallback(
        (html: string, plain: string): boolean => {
            const content = plain || htmlToPlainText(html);
            if (!content.trim()) return false;
            pasteTextElement(content, html ? toVectorTextAlign(readDominantTextAlign(html) ?? undefined) : 'left');
            return true;
        },
        [pasteTextElement],
    );

    // ⌘C / ⌘X / ⌘V via document-level ClipboardEvent listeners (the slides idiom — native events are
    // required to write the MIME flavors and to read the DataTransfer synchronously). Gated
    // canEdit && !editing; isTypingTarget() bails so the text overlay + a comments composer keep native
    // clipboard (the typing-target invariant). Eigen items are consumed FIRST; a non-eigen paste falls
    // through (capture phase, no stopPropagation) to the container's useFilePasteTarget for OS files.
    // The three listeners bind ONCE and read the live scene/selection/writers through this ref: a
    // canvas render (a drag preview, a pan commit) must not tear them down and rebuild them.
    const handlers = {
        canEdit,
        selectedIds,
        buildData,
        plainText,
        pasteEigenItems,
        pasteNonEigenText,
        insertImageFiles,
        viewportCenterScene,
        deleteElements,
        setSelectedIds,
        undoManager,
    };
    const live = useRef(handlers);
    live.current = handlers;

    useEffect(() => {
        const blocked = () => isTypingTarget() || !live.current.canEdit || textEditingRef.current;
        const onCopyEvent = (e: ClipboardEvent) => {
            const { selectedIds, buildData, plainText } = live.current;
            if (blocked() || selectedIds.length === 0) return;
            const data = buildData();
            if (!data.items.length) return;
            e.preventDefault();
            writeEigenClipboard(e, data, plainText());
        };
        const onCutEvent = (e: ClipboardEvent) => {
            const { selectedIds, buildData, plainText, deleteElements, setSelectedIds, undoManager } = live.current;
            if (blocked() || selectedIds.length === 0) return;
            const data = buildData();
            if (!data.items.length) return;
            e.preventDefault();
            writeEigenClipboard(e, data, plainText());
            // One sealed undo step (deleteSelection stopCaptures on both sides).
            deleteSelection(selectedIds, deleteElements, setSelectedIds, undoManager);
        };
        const onPasteEvent = (e: ClipboardEvent) => {
            const { pasteEigenItems, pasteNonEigenText, insertImageFiles, viewportCenterScene } = live.current;
            if (blocked()) return;
            const cd = e.clipboardData;
            if (!cd) return;
            const paste = classifyPaste(cd);
            // Eigen items are consumed FIRST (before the SVG rung) so a vector→vector paste restores
            // native elements instead of landing as one flat image.
            if (paste.eigen) {
                e.preventDefault();
                e.stopPropagation();
                pasteEigenItems(paste.eigen.items);
                return;
            }
            // A bare SVG on the clipboard: ours (the items in `<metadata>`) restores native elements;
            // any other SVG inserts as an image via the media path. OS files still fall through.
            if (paste.svg) {
                e.preventDefault();
                e.stopPropagation();
                const restored = extractClipboardSvgMetadata(paste.svg.svg);
                if (restored) pasteEigenItems(restored.items);
                else void insertImageFiles([svgToImageFile(paste.svg.svg)], viewportCenterScene());
                return;
            }
            // No eigen/SVG payload. OS files fall through to useFilePasteTarget (image drop path).
            if (paste.files.length > 0) return;
            // Plain text (or the text of pasted HTML) → a new rich-text box; only claim the event when
            // content is actually consumed, else it falls through to the OS-file path.
            if (pasteNonEigenText(paste.html, paste.text)) {
                e.preventDefault();
                e.stopPropagation();
            }
        };
        document.addEventListener('copy', onCopyEvent);
        document.addEventListener('cut', onCutEvent);
        document.addEventListener('paste', onPasteEvent, true);
        return () => {
            document.removeEventListener('copy', onCopyEvent);
            document.removeEventListener('cut', onCutEvent);
            document.removeEventListener('paste', onPasteEvent, true);
        };
    }, [textEditingRef]);

    // Menu clipboard rows: no ClipboardEvent here, so copy/cut go through the async writer and paste
    // through the async reader (eigen items only — OS files still need ⌘V). Same producer/consumer as
    // the keyboard path, so the two stay one behavior.
    const onMenuCopy = () => {
        const data = buildData();
        if (!data.items.length) return;
        // The inliner promise goes straight into the writer: the clipboard write must start inside
        // the user gesture (Safari/Firefox), not after the media fetch resolves.
        void writeEigenClipboardAsync(data, plainText(), foreignImgHtml(data.svg)).catch(() => {});
    };
    const onMenuCut = () => {
        const data = buildData();
        if (!data.items.length) return;
        // Delete only once the async write lands — a denied/failed clipboard write must not destroy
        // the selection (the content would exist nowhere but the undo stack).
        void writeEigenClipboardAsync(data, plainText(), foreignImgHtml(data.svg))
            .then(() => deleteSelection(selectedIds, deleteElements, setSelectedIds, undoManager))
            .catch(() => {});
    };
    const onMenuPaste = () => {
        (async () => {
            const data = await readEigenClipboardAsync();
            if (data) {
                pasteEigenItems(data.items);
                return;
            }
            // Non-eigen clipboard: mirror the keyboard path's plain-text fallback (same
            // pasteNonEigenText policy). OS-file image paste stays ⌘V-only (the async API exposes no
            // File objects for the drop pipeline).
            let html = '';
            let text = '';
            for (const clip of await navigator.clipboard.read()) {
                if (!html && clip.types.includes('text/html')) html = await (await clip.getType('text/html')).text();
                if (!text && clip.types.includes('text/plain')) text = await (await clip.getType('text/plain')).text();
            }
            pasteNonEigenText(html, text);
        })().catch(() => {
            /* clipboard read denied or unavailable */
        });
    };

    return { onMenuCopy, onMenuCut, onMenuPaste };
}
