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
import type {
    EigenClipboardImageItem,
    EigenClipboardItem,
    EigenClipboardTypography,
} from '@workspace/lib/types/clipboard';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    DEFAULT_RICHTEXT_PROPS,
    FONT_STYLES,
    FONT_WEIGHTS,
    IMAGE_CASCADE_OFFSET,
    num,
    oneOf,
    type Point,
    pasteAnchorOffset,
    readElementsClipboardItem,
    reanchorElements,
    type StyleDefaults,
    TEXT_ALIGNS,
    TEXT_DECORATIONS,
    type TextAlign,
    VERTICAL_ALIGNS,
    type VectorElement,
    type VectorMeta,
} from '@workspace/lib/vector';
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type * as Y from 'yjs';
import { isTypingTarget } from '../../../hooks/is-typing-target';
import { measureVectorText } from '../text-measure';
import { remapPastedArrows } from '../tools/binding';
import { buildSelectionData, selectionPlainText } from '../tools/clipboard';
import { type PastePlan, planElementsPaste } from '../tools/paste-elements';
import { deleteSelection } from './selection-ops';
import { type NewVectorElement, sealed, type VectorElementPatch } from './use-canvas-doc';

// How many cross-mount images re-upload at once. The wire is forgeable, so a paste must not turn into
// hundreds of parallel fetch + upload round-trips; a handful keeps a normal multi-image paste quick.
const REUPLOAD_CONCURRENCY = 4;

// Foreign typography → the rich-text fields it names. This is the full set a rich-text box models, which
// is also the full set the canvas producer writes: nothing on that wire goes unread. The fields below are
// coerced with `oneOf`/`num`, the same clamps the document reader applies to a stored field, so a pasted
// value can only ever be one a peer write could have made. The three the CALLER reads — fontFamily,
// fontSize, color — ride in unclamped and are clamped on the way out instead, by the reader every render,
// export and preview goes through (font list, 4-400px, colour token), exactly as any peer write is.
function richTextTypography(typo: EigenClipboardTypography) {
    return {
        textAlign: oneOf(typo.textAlign, TEXT_ALIGNS, DEFAULT_RICHTEXT_PROPS.textAlign),
        fontWeight: oneOf(typo.fontWeight, FONT_WEIGHTS, DEFAULT_RICHTEXT_PROPS.fontWeight),
        fontStyle: oneOf(typo.fontStyle, FONT_STYLES, DEFAULT_RICHTEXT_PROPS.fontStyle),
        textDecoration: oneOf(typo.textDecoration, TEXT_DECORATIONS, DEFAULT_RICHTEXT_PROPS.textDecoration),
        verticalAlign: oneOf(typo.verticalAlign, VERTICAL_ALIGNS, DEFAULT_RICHTEXT_PROPS.verticalAlign),
        letterSpacing: num(typo.letterSpacing, DEFAULT_RICHTEXT_PROPS.letterSpacing),
        lineHeight: num(typo.lineHeight, DEFAULT_RICHTEXT_PROPS.lineHeight),
    };
}

// Cut deletes only what the clipboard carries, so an image that could not be serialized stays put. Tell
// the user, or the difference between "cut" and "cut most of it" is invisible — and between "cut" and
// "did nothing at all" when the selection was that image alone.
function warnPartialCut(pendingImages: number) {
    if (pendingImages <= 0) return;
    toast.info(
        pendingImages === 1
            ? 'One image is still uploading, so it stayed in the drawing'
            : `${pendingImages} images are still uploading, so they stayed in the drawing`,
    );
}

// A non-collapsed text selection OUTSIDE the canvas, if there is one: the run a copy would carry.
function outsideTextSelection(container: HTMLElement | null): Selection | null {
    const selection = container?.ownerDocument.getSelection() ?? null;
    if (!selection || selection.isCollapsed || selection.toString().trim() === '') return null;
    const node = selection.anchorNode;
    return node && container?.contains(node) ? null : selection;
}

// The canvas drops such a run when the pointer lands on it. The surface is `select-none` and the
// in-place editor swallows its own pointerdown, so nothing else ever collapses a selection made in the
// comments pane or the properties panel — it would survive the click that selects an element and keep
// owning ⌘C/⌘X, copying that text and cutting nothing.
export function dropOutsideTextSelection(container: HTMLElement | null): void {
    outsideTextSelection(container)?.removeAllRanges();
}

type CanvasClipboardParams = {
    canEdit: boolean;
    // Read from listeners bound once, so the live "a text surface owns the keyboard" answer rides a
    // ref: the overlay and the in-place editor keep native clipboard while they are open.
    textEditingRef: { current: boolean };
    // The canvas surface, for the same question about the MOUSE: a text run selected outside it (a
    // comment, the activity list) owns copy/cut.
    containerRef: { current: HTMLDivElement | null };
    viewport: 'infinite' | 'frame';
    frameId: string;
    // The host's table for a NEW element (vector: Excalifont 20, slides: Inter 48). A pasted text box
    // is a new element like any other, so it is measured and created with this, never the engine's own
    // defaults — else ⌘V and the T tool disagree on the same slide.
    styleDefaults: StyleDefaults;
    // The scene in z-order, its background, and the selection — what a copy serializes.
    ordered: VectorElement[];
    meta: VectorMeta;
    selectedIds: string[];
    setSelectedIds: (ids: string[]) => void;
    // Frame-stamped writers: the canvas' own addElement/addElements wrappers stamp the active frameId
    // after the caller's fields, so a pasted element lands in the frame being pasted INTO, never the
    // one it was copied from.
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
    const { canEdit, textEditingRef, containerRef, viewport, frameId, ordered, meta, selectedIds } = params;
    const { styleDefaults } = params;
    const { setSelectedIds } = params;
    const { addElement, addElements, updateElements, updateElementUntracked } = params;
    const { deleteElements, deleteElementsUntracked, undoManager } = params;
    const { viewportCenterScene, insertImageFiles, mediaFolderId } = params;
    const { resolveMediaPath, resolveMediaUrl, uploadFile } = params;

    // The clipboard PRODUCER (the native elements item, the typed image/text items and the
    // self-contained SVG flavour) + the plain-text flavor live in ../tools/clipboard; this calls them
    // with the live z-order, selection, background, home frame and path resolver.
    const buildData = useCallback(
        () => buildSelectionData(ordered, selectedIds, meta, frameId, resolveMediaPath),
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
                    // No source folder on the wire is forged or incomplete: re-upload it like any
                    // cross-mount item rather than trust a name that resolves against nothing here.
                    const crossMount = !item.sourceParentId || needsReUpload(item.sourceParentId, mediaFolderId);
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
                const fontFamily = typo.fontFamily ?? styleDefaults.fontFamily;
                const fontSize = num(typo.fontSize, styleDefaults.fontSize);
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
                    color: typo.color,
                    ...richTextTypography(typo),
                });
            }
            return plan;
        },
        [viewportCenterScene, mediaFolderId, styleDefaults],
    );

    // One paste = one undo step: every ADD in one transact, the arrow-binding remap inside the same
    // capture window (one `sealed` around both), then the cross-mount images resolve untracked.
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

            // Cross-mount images: fetch from source, re-upload into our media/, swap the pending name
            // (late transact) or drop the element on failure — the shared optimistic-insert idiom. A
            // forged wire can carry hundreds of image items, so a few drain at a time instead of firing
            // every fetch + upload at once.
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
                    // Untracked: this technical swap is NOT its own undo step, so the whole cross-mount
                    // paste is a single ⌘Z (reverts the insert; peers converge via its inverse). Redo
                    // re-adds the element at its recorded pending name, the accepted edge of every
                    // optimistic insert.
                    if (result) updateElementUntracked(id, { mediaName: result.mediaName });
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
            updateElementUntracked,
            deleteElementsUntracked,
        ],
    );

    // Element clipboard CONSUMER. Our own payload restores NATIVE elements — whole stored records
    // through the reader, re-anchored as a set — and its image items are only the re-upload manifest.
    // A foreign payload falls back to the cross-app items.
    //
    // Returns whether anything was actually placed. A payload can be non-empty and still place nothing —
    // every item dropped as forged at the read seam, or images with no media/ folder to upload into — and
    // the caller must not claim the event for a paste that did nothing (the rungs below it, and the
    // container's OS-file handler, still deserve their turn).
    const pasteEigenItems = useCallback(
        (items: EigenClipboardItem[]): boolean => {
            if (!items.length) return false;
            const native = readElementsClipboardItem(items);
            if (!native?.elements.length) return commitPaste(planForeignPaste(items));
            const { dx, dy } = pasteAnchorOffset(
                native.elements,
                native.sourceFrameId,
                viewport === 'frame' ? frameId : '',
                viewportCenterScene(),
            );
            const imageItems = items.filter((i): i is EigenClipboardImageItem => i.type === 'image');
            return commitPaste(planElementsPaste(reanchorElements(native.elements, dx, dy), imageItems, mediaFolderId));
        },
        [commitPaste, planForeignPaste, viewport, frameId, viewportCenterScene, mediaFolderId],
    );

    // An SVG string → native elements when it is one of ours (its items ride a `<metadata>` block).
    // False for a foreign drawing, which the caller then inserts as an image. Shared by ⌘V's svg rung
    // and the file-drop path, so dropping an .svg we exported restores elements exactly as pasting it does.
    const pasteSvgText = useCallback(
        (svg: string): boolean => {
            const restored = extractClipboardSvgMetadata(svg);
            return restored ? pasteEigenItems(restored.items) : false;
        },
        [pasteEigenItems],
    );

    // Plain-text paste (no eigen payload, no OS files) → ONE rich-text box at the viewport centre, in the
    // HOST's typography and with a locally-measured box (the pasteEigenItems text idiom). The partial names
    // no font, so the box is created with the same table it is measured with. Multi-line text is preserved
    // — textToParagraphHtml keeps one paragraph per line. One sealed undo step.
    const pasteTextElement = useCallback(
        (text: string, textAlign: TextAlign = 'left') => {
            const anchor = viewportCenterScene();
            const { width: w, height: h } = measureVectorText(text, styleDefaults.fontSize, styleDefaults.fontFamily);
            const id = sealed(undoManager, () =>
                addElement({
                    type: 'richtext',
                    x: anchor.x - w / 2,
                    y: anchor.y - h / 2,
                    width: w,
                    height: h,
                    angle: 0,
                    html: textToParagraphHtml(text),
                    textAlign,
                }),
            );
            if (id) setSelectedIds([id]);
        },
        [viewportCenterScene, addElement, setSelectedIds, undoManager, styleDefaults],
    );

    // Non-eigen text paste (the keyboard fallthrough and the async menu path share this policy): plain
    // text, or the flattened text of pasted HTML, becomes one rich-text box. Prose alignment rides in
    // text/html as a block text-align; carry it through toVectorTextAlign (justify→left). Returns true
    // when it consumed content so the keyboard handler can gate its preventDefault on a real paste.
    const pasteNonEigenText = useCallback(
        (html: string, plain: string): boolean => {
            const content = plain || htmlToPlainText(html);
            if (!content.trim()) return false;
            pasteTextElement(content, html ? oneOf(readDominantTextAlign(html), TEXT_ALIGNS, 'left') : 'left');
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
        // Such a run owns copy/cut: the user is copying that text (a comment, an activity row), and
        // writing the element payload would take the clipboard from them with nothing on screen to
        // explain it. Inside the canvas there is no text to copy — the in-place editor is `blocked()`
        // above — so only the outside case bails.
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
                // A selection of only still-uploading images serializes to nothing: there is no payload
                // to write and nothing that may be deleted. Claim the event and say why anyway — silently
                // doing nothing is indistinguishable from a cut that worked.
                if (!pendingImages) return;
                e.preventDefault();
                warnPartialCut(pendingImages);
                return;
            }
            e.preventDefault();
            writeEigenClipboard(e, data, plainText());
            // Delete ONLY what the payload carries. An image whose media path doesn't resolve yet was
            // left out of the copy, so cutting it would destroy the one copy that existed — undo is not
            // a substitute for not losing it. One sealed undo step (deleteSelection stopCaptures on both
            // sides).
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
            // Eigen items are consumed FIRST (before the SVG rung) so a vector→vector paste restores
            // native elements instead of landing as one flat image. The event is claimed only if
            // something was actually placed: a payload whose items were all dropped at the read seam,
            // or images with no media/ folder to land in, must fall through to the rungs below rather
            // than swallow the paste.
            if (paste.eigen && pasteEigenItems(paste.eigen.items)) {
                claim();
                return;
            }
            // A bare SVG on the clipboard: ours (the items in `<metadata>`) restores native elements;
            // any other SVG inserts as an image via the media path. OS files still fall through.
            if (paste.svg) {
                if (pasteSvgText(paste.svg.svg)) {
                    claim();
                    return;
                }
                // A foreign SVG lands as an IMAGE, which needs a media/ folder to upload into —
                // insertImageFiles places nothing without one, so this rung claims the paste only when
                // it can actually place it and otherwise leaves the text rung below its turn.
                if (mediaFolderId) {
                    claim();
                    void insertImageFiles([svgToImageFile(paste.svg.svg)], viewportCenterScene());
                    return;
                }
            }
            // Nothing placed by the rungs above. OS files fall through to useFilePasteTarget (image drop path).
            if (paste.files.length > 0) return;
            // Plain text (or the text of pasted HTML) → a new rich-text box; only claim the event when
            // content is actually consumed, else it falls through to the OS-file path.
            if (pasteNonEigenText(paste.html, paste.text)) {
                claim();
                return;
            }
            // An eigen payload was there and no rung could place any of it. Without this ⌘V is a dead
            // key with no explanation.
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

    // Menu clipboard rows: no ClipboardEvent here, so copy/cut go through the async writer and paste
    // through the async reader (eigen items only — OS files still need ⌘V). Same producer/consumer as
    // the keyboard path, so the two stay one behavior.
    const onMenuCopy = () => {
        const { data } = buildData();
        if (!data.items.length) return;
        // The inliner promise goes straight into the writer: the clipboard write must start inside
        // the user gesture (Safari/Firefox), not after the media fetch resolves.
        void writeEigenClipboardAsync(data, plainText(), foreignImgHtml(data.svg)).catch(() => {});
    };
    const onMenuCut = () => {
        if (!canEdit) return;
        const { data, serializedIds, pendingImages } = buildData();
        if (!data.items.length) {
            // Nothing serialized — the keyboard sibling's case, minus an event to claim.
            warnPartialCut(pendingImages);
            return;
        }
        // Delete only once the async write lands — a denied/failed clipboard write must not destroy
        // the selection (the content would exist nowhere but the undo stack) — and only the ids the
        // payload actually carries, exactly like the keyboard path.
        void writeEigenClipboardAsync(data, plainText(), foreignImgHtml(data.svg))
            .then(() => {
                deleteSelection(serializedIds, deleteElements, setSelectedIds, undoManager);
                warnPartialCut(pendingImages);
            })
            .catch(() => {});
    };
    const onMenuPaste = () => {
        // The keyboard sibling is gated on canEdit; so is this one. The object menu only opens when
        // canEdit today, but a clipboard write must never depend on a caller remembering that.
        if (!canEdit) return;
        (async () => {
            const data = await readEigenClipboardAsync();
            if (data && pasteEigenItems(data.items)) return;
            // Nothing placed yet: walk the SAME ladder ⌘V does, over the same classifier, so the menu
            // row and the keystroke are one behaviour — an SVG restores our elements or lands as an
            // image, anything else becomes a rich-text box. OS-file image paste stays ⌘V-only (the async
            // API exposes no File objects for the drop pipeline).
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
            // An eigen payload was there and no rung could place any of it — the keyboard path's toast,
            // for the same reason: ⌘V doing nothing silently is indistinguishable from a broken menu.
            if (data) toast.info('Nothing in this paste could be placed on the canvas');
        })().catch(() => {
            /* clipboard read denied or unavailable */
        });
    };

    return { onMenuCopy, onMenuCut, onMenuPaste, pasteSvgText };
}
