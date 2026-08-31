import {
    clipboardTextItemHasContent,
    extractClipboardSvgMetadata,
    needsReUpload,
    readClipboardBox,
    readEigenClipboard,
    readEigenClipboardAsync,
    readSvgClipboard,
    reUploadImage,
    svgToImageFile,
    writeEigenClipboard,
    writeEigenClipboardAsync,
} from '@workspace/lib/clipboard';
import {
    isPendingMediaName,
    useCopyToMediaFolder,
    useMediaResolver,
    useUploadFile,
    useZombieMediaSweep,
} from '@workspace/lib/drive';
import { htmlToPlainText, readDominantTextAlign } from '@workspace/lib/html-dom';
import type { EigenClipboardData, EigenClipboardImageItem, EigenClipboardItem } from '@workspace/lib/types/clipboard';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    arrowRoute,
    type Bounds,
    type Box,
    computeSnapTargets,
    DEFAULT_FONT_FAMILY,
    DEFAULT_FONT_SIZE,
    elementBounds,
    fitImageSize,
    getElementsBounds,
    type ImageSize,
    isLinearElement,
    isTransparent,
    type MarqueeMode,
    marqueeMode,
    orderByFractionalIndex,
    parsePoints,
    resizeLinear,
    SNAP_SCREEN_THRESHOLD,
    type SnapLine,
    type SnapTargets,
    snapBoxToTargets,
    type TextAlign,
    unionBounds,
    type VectorArrowElement,
    type VectorElement,
    type VectorMeta,
    type VectorTextElement,
} from '@workspace/lib/vector';
import { ObjectTransform } from '@workspace/ui/components/transform/object-transform';
import { cn } from '@workspace/ui/lib/utils';
import { Image as ImageIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WebsocketProvider } from 'y-websocket';
import type * as Y from 'yjs';
import { isTypingTarget } from '../../hooks/is-typing-target';
import { useFileDropTarget } from '../../hooks/use-file-drop-target';
import { useFilePasteTarget } from '../../hooks/use-file-paste-target';
import { CursorLayer } from '../collab';
import { useContextMenu } from '../context-menu';
import { FileDropOverlay } from '../file-drop-overlay';
import { HintPill } from '../hint-pill';
import { readImageSize, readImageSizeFromUrl } from '../media/read-image-size';
import type { ZOp } from '../properties-panel/z-order';
import { pointerCursor } from './cursor';
import { ElementNode } from './element-node';
import { hitTestTopmost, marqueeSelect } from './hooks/use-selection';
import { useSpaceHeld } from './hooks/use-space-held';
import type { VectorTool } from './hooks/use-tool';
import type { NewVectorElement, VectorElementPatch } from './hooks/use-vector-doc';
import { applyZOrder, deleteSelection, duplicateSelection, useVectorKeyboard } from './hooks/use-vector-keyboard';
import type { PublishCursor } from './hooks/use-vector-presence';
import { useViewport } from './hooks/use-viewport';
import { arrowLabelEditing, type EditingState, newTextEditing, textEditing } from './text-editing';
import { isVectorFontLoaded, loadVectorFont, measureVectorText } from './text-measure';
import { TextOverlay } from './text-overlay';
import {
    buildPreviewById,
    followArrowPreview,
    type PastedArrow,
    remapPastedArrows,
    unbindDraggedArrow,
} from './tools/binding';
import {
    buildSelectionData,
    readVectorMeta,
    selectionPlainText,
    toVectorTextAlign,
    type VectorClipMeta,
} from './tools/clipboard';
import { type CreatingState, creatingElement, newShapeBox, normalizeRect } from './tools/create-shape';
import { SnapGuides } from './tools/snap-guides';
import { useDrawingTools } from './tools/use-drawing-tools';
import { VectorObjectMenu } from './vector-object-menu';

const SVG_NS = 'http://www.w3.org/2000/svg';
// Below this scene-unit extent (in BOTH dimensions) a drag-create is a click → discarded.
const CREATE_MIN_SIZE = 1;
const MIN_ELEMENT_SIZE = 1;
// fontSize clamp for resize-scaling of text (a resize maps width ratio → fontSize).
const MIN_FONT_SIZE = 4;
const MAX_FONT_SIZE = 400;
// Image drop/paste SIZING (natural-size-that-fits, 80% viewport cap, never upscale, unreadable →
// default box) is the shared `fitImageSize` helper — vector is its reference behavior. Only the
// CASCADE offset stays vector-side.
// Each subsequent image in a multi-file drop staggers by this many scene units so a stack of
// natural-size images stays visible (⌘D's +10 is for identical duplicates; images need more).
const IMAGE_CASCADE_OFFSET = 20;
// A bound arrow dragged alone unbinds only past this SCREEN distance, so a click-select never detaches it
// (Excalidraw's DRAGGING_THRESHOLD).
const ARROW_UNBIND_SCREEN = 10;

function elementBox(el: VectorElement): Box {
    return { x: el.x, y: el.y, width: el.width, height: el.height, angle: el.angle };
}

function boundsToBox(b: Bounds): Box {
    return { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY, angle: 0 };
}

function boxToBounds(b: Box): Bounds {
    return { minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height };
}

function clampFontSize(size: number): number {
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
}

// pointerId gates move/up to the pointer that started the gesture — on touch, a second finger's
// events would otherwise drive (and prematurely commit) the first finger's gesture.
type Gesture = { pointerId: number } & (
    | { kind: 'pan'; lastX: number; lastY: number }
    | {
          kind: 'move';
          startX: number;
          startY: number;
          originals: Record<string, { x: number; y: number }>;
          ids: string[];
          moved: boolean;
          // The selected elements, snapshotted here (committed geometry is invariant for the gesture —
          // only previews move), so the move tick reads them instead of re-scanning the scene per frame.
          selById: Map<string, VectorElement>;
          // Snap targets = every OTHER element's edges/centre, invariant for the gesture (only
          // previews move; committed elements don't), so compute once here instead of per tick.
          snapTargets: SnapTargets;
      }
    | { kind: 'create'; startX: number; startY: number }
    | { kind: 'marquee'; startX: number; startY: number; additive: boolean; base: string[] }
);

// Imperative image-insert surface the canvas publishes for the toolbar's Insert entries — the
// editor owns the picker dialog, but placement needs the live viewport (centre + zoom).
export type VectorImageInsert = {
    insertFiles: (files: File[]) => void;
    insertDrivePaths: (paths: DrivePath[]) => Promise<void>;
};

type VectorCanvasProps = {
    elements: VectorElement[];
    meta: VectorMeta;
    tool: VectorTool;
    setTool: (t: VectorTool) => void;
    // Tool lock (Q / padlock): a placement keeps the current tool active; threaded like `tool`, toggled here on Q.
    toolLocked: boolean;
    setToolLocked: (locked: boolean) => void;
    canWrite: boolean;
    // Owner + mount of THIS document, for cross-mount image paste (re-upload into our media/ folder).
    ownerId: string;
    mountId: string;
    addElement: (partial: NewVectorElement) => string | undefined;
    // Batch add (paste) — the whole set in ONE transact / one undo step.
    addElements: (partials: NewVectorElement[]) => string[];
    updateElement: (id: string, fields: VectorElementPatch) => void;
    // Non-undoable single-element update — the cross-mount pending→real image swap, so the paste stays
    // one undo step (peers still receive it).
    updateElementUntracked: (id: string, fields: VectorElementPatch) => void;
    updateElements: (patches: { id: string; fields: VectorElementPatch }[]) => void;
    deleteElements: (ids: string[]) => void;
    // Non-undoable delete — cleanup of a failed optimistic image insert, so the failed paste/drop
    // leaves no undo step that resurrects a broken pending element.
    deleteElementsUntracked: (ids: string[]) => void;
    duplicateElements: (ids: string[], dx: number, dy: number) => string[];
    undoManager: Y.UndoManager | null;
    // Selection is lifted to the editor so the properties panel and canvas share one source (the
    // slides editor/canvas idiom).
    selectedIds: string[];
    setSelectedIds: (ids: string[]) => void;
    toggle: (id: string) => void;
    // Aspect lock, shared with the properties-panel checkbox. Non-text selections map
    // it to ObjectTransform's 'aspect-default'/'free' resizeMode; text stays forced 'aspect'.
    aspectLocked: boolean;
    // Awareness: the provider drives the CursorLayer's own subscription; publishCursor pushes the
    // local pointer's scene position (throttled in the editor's use-vector-presence).
    provider: WebsocketProvider | null;
    publishCursor: PublishCursor;
    // Published/cleared by the canvas itself; optional so read-only hosts can omit it.
    imageInsertRef?: { current: VectorImageInsert | null };
};

// The live, interactive SVG scene surface: pan/zoom viewport, tool-driven drag-create, selection,
// move, and the shared ObjectTransform chrome. Every drag/resize/rotate preview is LOCAL state;
// exactly one Yjs transact fires per completed gesture (UX-RULING 5), with stopCapturing() at each
// gesture start so one gesture = one undo step.
export function VectorCanvas({
    elements,
    meta,
    tool,
    setTool,
    toolLocked,
    setToolLocked,
    canWrite,
    ownerId,
    mountId,
    addElement,
    addElements,
    updateElement,
    updateElementUntracked,
    updateElements,
    deleteElements,
    deleteElementsUntracked,
    duplicateElements,
    undoManager,
    selectedIds,
    setSelectedIds,
    toggle,
    aspectLocked,
    provider,
    publishCursor,
    imageInsertRef,
}: VectorCanvasProps) {
    const {
        containerRef,
        clientToScene,
        screenDeltaToScene,
        boxToStyle,
        groupTransform,
        panBy,
        resetZoom,
        frozenRef,
        zoom,
    } = useViewport();
    // Images resolve/upload through the container's media/ folder (the provider the editor wraps
    // us in). resolveMediaUrl feeds every <image> href; startUpload drives the optimistic insert;
    // resolveMediaPath gives a copied image a portable source path for cross-mount paste.
    const { resolveMediaUrl, resolveMediaUrlByPath, resolveMediaPath, startUpload, mediaFolderId } = useMediaResolver();
    // Cross-mount paste re-uploads a copied image's blob into OUR media/ folder; mutateAsync is stable.
    const uploadFile = useUploadFile(ownerId, mountId);
    // Toolbar "Add image" drive picks copy into media/ first (the slides idiom); mutateAsync is stable.
    const { mutateAsync: copyToMediaFolder } = useCopyToMediaFolder(ownerId, mountId);

    const [previews, setPreviews] = useState<Record<string, Box>>({});
    const [creating, setCreating] = useState<CreatingState | null>(null);
    // The marquee carries its direction mode so the render can signal it (solid = contain, dashed =
    // intersect) — slides' visual convention, shared here.
    const [marquee, setMarquee] = useState<{ box: Box; mode: MarqueeMode } | null>(null);
    // Active snap guide lines (scene coords) while a move/resize gesture is snapping. Rendered as
    // SVG lines in the scene group; cleared on gesture end.
    const [snapLines, setSnapLines] = useState<SnapLine[]>([]);
    const spaceHeld = useSpaceHeld();
    const [panning, setPanning] = useState(false);
    // Select-mode hover affordance: true while the idle pointer is over a selectable element, so the
    // cursor signals draggability with `move` (the suite convention — slides/docs). Item E.
    const [hoveringSelectable, setHoveringSelectable] = useState(false);
    const [editing, setEditing] = useState<EditingState | null>(null);
    // The object context menu (right-click) — the singleton surface; item is the right-clicked
    // element id, its ops act on the selection below.
    const objectContextMenu = useContextMenu<string>();

    const gestureRef = useRef<Gesture | null>(null);
    // First onTransform of a resize/rotate is the de-facto gesture start (ObjectTransform fires it
    // synchronously at grip pointerdown); flip it there for the one-stopCapturing-per-gesture rule.
    const transformStartedRef = useRef(false);
    // Latest finishGesture closure, for the window-blur listener bound once below.
    const finishRef = useRef<() => void>(() => {});
    // Live editing session, read from event listeners (bound once) that must know a text overlay is
    // open — the freeze safety-net below and commitEditing both consult it.
    const editingRef = useRef<EditingState | null>(null);
    editingRef.current = editing;

    const ordered = useMemo(() => orderByFractionalIndex(elements), [elements]);

    // All elements by id (committed scene) — the map an elbow arrow reads (arrowRoute) to resolve its
    // bound shapes and derive its route. Hit/marquee/label paths use it; the render path overlays previews.
    const committedById = useMemo(() => new Map(ordered.map((el) => [el.id, el])), [ordered]);

    // Element boxes by id for the shared CursorLayer's remote selection rings — rebuilt only when the
    // scene changes, never on a peer cursor tick (the layer holds its own awareness subscription).
    const cursorBoxes = useMemo(() => {
        const m = new Map<string, Box>();
        // An elbow arrow's ring must enclose its ROUTED polyline (the derived route or, when pinned, the
        // stored polyline), never the raw 2-endpoint frame — elementBounds(el, route). Others keep their
        // own rotated box.
        for (const el of ordered) {
            m.set(
                el.id,
                el.type === 'arrow' && el.elbow
                    ? boundsToBox(elementBounds(el, arrowRoute(el, committedById)))
                    : elementBox(el),
            );
        }
        return m;
    }, [ordered, committedById]);

    // Freehand / line / eraser gestures + line point-handles live in a sibling hook (the canvas only
    // dispatches) — CANVAS.md's rule that this file must not grow. `busy` hides the point handles while
    // any canvas gesture or overlay owns the surface.
    const drawing = useDrawingTools({
        tool,
        setTool,
        toolLocked,
        canWrite,
        zoom,
        ordered,
        byId: committedById,
        selectedIds,
        busy: Object.keys(previews).length > 0 || !!creating || !!marquee || !!editing,
        containerRef,
        frozenRef,
        clientToScene,
        boxToStyle,
        addElement,
        updateElement,
        deleteElements,
        setSelectedIds,
        undoManager,
    });

    // Elements with their live preview boxes applied — the map a bound arrow follows while its shape is
    // mid-drag. Built only while a preview is live AND the scene holds an arrow, so an arrow-free
    // drag doesn't reallocate it every frame.
    const hasPreviews = Object.keys(previews).length > 0;
    const hasArrows = ordered.some((el) => el.type === 'arrow');
    const previewById = useMemo(
        () => (hasPreviews && hasArrows ? buildPreviewById(ordered, previews) : null),
        [hasPreviews, hasArrows, ordered, previews],
    );
    // The map the render path feeds an elbow arrow's route: preview boxes when a shape is mid-drag (the
    // snake follows live), else the committed scene — its per-frame identity is the ElementNode memo's cue.
    const renderById = previewById ?? committedById;

    // An element renders with its live local preview (move/resize/rotate) overriding the Yjs values;
    // no preview → same object identity, so the memo skips it. A linear element's resize/rotate derives
    // scaled points per frame through resizeLinear; a bound arrow whose shape is being previewed
    // follows it per frame; an element marked for erasure dims to 20%.
    const renderEl = (el: VectorElement): VectorElement => {
        const p = previews[el.id];
        let out = el;
        if (p) {
            // Only a size change needs the per-frame point rescale; a move/rotate-only preview applies
            // x/y/angle straight through (resizeLinear would re-derive the same box and points).
            if (isLinearElement(el) && (p.width !== el.width || p.height !== el.height)) {
                out = { ...el, ...resizeLinear(el, p), angle: p.angle };
            } else {
                out = { ...el, x: p.x, y: p.y, width: p.width, height: p.height, angle: p.angle };
            }
        } else if (previewById && el.type === 'arrow') {
            const follow = followArrowPreview(el, previews, previewById);
            if (follow) out = { ...el, ...follow };
        }
        if (drawing.erasingIds.has(el.id)) out = { ...out, opacity: out.opacity * 0.2 };
        return out;
    };

    // Every canvas hotkey (V/R/D/O/T, Delete/Backspace, arrows, ⌘A, ⌘D, ⌘Z/⌘⇧Z, z-order) is gated
    // off while a text overlay is open — the textarea's native undo/typing owns keys in-session; we
    // don't rely on the hotkey lib's input-target detection alone (UX-RULING, commit-trigger).
    useVectorKeyboard({
        enabled: canWrite && !editing,
        elements,
        selectedIds,
        tool,
        setTool,
        toolLocked,
        setToolLocked,
        setSelection: setSelectedIds,
        undoManager,
        deleteElements,
        updateElements,
        duplicateElements,
    });

    // Freeze the viewport while an overlay is open (same latch as gestures): a pan/zoom would
    // desync the overlay from the element it sits over.
    useEffect(() => {
        if (!editing) return;
        frozenRef.current = true;
        return () => {
            frozenRef.current = false;
        };
    }, [editing, frozenRef]);

    // Safety net: any pointerup ends the freeze, clears the transform-start latch, and drops
    // leftover previews — ObjectTransform's Escape-cancel and no-move paths fire no onCommit, so
    // their snapshot preview would otherwise stick and mask later remote edits of that element.
    // (Registered at mount, so on a normal commit this runs before ObjectTransform's own pointerup
    // listener; the batched onCommit write supersedes the clear in the same render.) window blur
    // can swallow the pointerup entirely (alt-tab mid-drag) — finalize any active canvas gesture
    // first, mirroring ObjectTransform's commit-on-blur, so no gesture is left live tracking a
    // released pointer when focus returns.
    useEffect(() => {
        const clear = () => {
            // An open text session owns the freeze until it commits/discards — the opening click's
            // own pointerup and every intra-textarea caret click must NOT unfreeze it (else wheel
            // zoom, a re-opened session, or a spurious move gesture leak in mid-edit). The editing
            // effect below clears the freeze when the session ends.
            if (editingRef.current) return;
            frozenRef.current = false;
            transformStartedRef.current = false;
            setPreviews((p) => (Object.keys(p).length ? {} : p));
            // Escape-cancelled resizes fire no onCommit, so stale guide lines land here.
            setSnapLines((l) => (l.length ? [] : l));
        };
        const onBlur = () => {
            if (editingRef.current) return; // the textarea's own onBlur commits the session
            finishRef.current();
            clear();
        };
        document.addEventListener('pointerup', clear);
        document.addEventListener('pointercancel', clear);
        window.addEventListener('blur', onBlur);
        return () => {
            document.removeEventListener('pointerup', clear);
            document.removeEventListener('pointercancel', clear);
            window.removeEventListener('blur', onBlur);
        };
    }, [frozenRef]);

    // Layered Escape (bubble phase): ObjectTransform claims mid-resize/rotate Escapes in the capture
    // phase and stops them, so this never fires during a grip drag. It cancels an in-progress
    // canvas gesture, else deselects, else returns to the select tool.
    const escRef = useRef({ hasSelection: false, tool });
    escRef.current = { hasSelection: selectedIds.length > 0, tool };
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            // A dialog/palette input owns its own Escape (close, clear); no gesture can be active
            // while one has focus, so skipping the whole handler is safe.
            if (e.key !== 'Escape' || isTypingTarget()) return;
            const g = gestureRef.current;
            if (g) {
                gestureRef.current = null;
                frozenRef.current = false;
                if (g.kind === 'create') {
                    setCreating(null);
                    setTool('select');
                } else if (g.kind === 'marquee') {
                    setMarquee(null);
                    // Cancel restores the gesture's base: the prior set for additive marquees,
                    // empty for plain ones (pressing empty canvas deselects immediately, so
                    // Escape staying deselected is the Excalidraw-consistent model).
                    setSelectedIds(g.base);
                } else if (g.kind === 'move') {
                    setPreviews({});
                    setSnapLines([]);
                } else {
                    setPanning(false);
                }
                return;
            }
            const s = escRef.current;
            if (s.hasSelection) setSelectedIds([]);
            else if (s.tool !== 'select') setTool('select');
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [frozenRef, setTool, setSelectedIds]);

    // Open the overlay on a new text element, an existing one, or an arrow's label. The session shapes
    // live in the pure text-editing module; the canvas only picks the selection and opens.
    const openNewText = (x: number, y: number) => {
        setSelectedIds([]);
        setEditing(newTextEditing(x, y));
    };

    const openEditExisting = (el: VectorTextElement) => {
        setSelectedIds([el.id]);
        setEditing(textEditing(el));
    };

    const openEditArrowLabel = (el: VectorArrowElement) => {
        const ed = arrowLabelEditing(el, arrowRoute(el, committedById));
        if (!ed) return; // a degenerate arrow (< 2 points) has no label anchor
        setSelectedIds([el.id]);
        setEditing(ed);
    };

    // The overlay awaits loadVectorFont on open, so commit-time measureVectorText is normally exact.
    // The safety net for the rare commit-before-load-resolves race: if the face isn't loaded, load it
    // and re-measure into the element once it swaps in (self-healing — stored dims are the server
    // renderer's source of truth, and the measurement util stays the sole dim writer). Re-validated
    // against the LIVE element at resolve time: a newer edit (text/font/size) owns the dims, so a
    // slow load can never write stale dims over it — and the single .then can't loop.
    const elementsRef = useRef(elements);
    elementsRef.current = elements;

    // Snap targets = every OTHER element's edges/centre (rotated → centre only). Infinite canvas, so no
    // canvas-edge guides (slides seeds those). Threshold is screen-space: SNAP_SCREEN_THRESHOLD / zoom
    // keeps the snap radius a constant pixel distance at any zoom.
    const buildSnapTargets = useCallback(
        (excludeIds: Set<string>) =>
            computeSnapTargets(
                elementsRef.current.map((el) => ({ id: el.id, box: elementBox(el) })),
                excludeIds,
            ),
        [],
    );

    // Resize-time snapping, fed to ObjectTransform's snapBox seam (the resize half of snapping; move snaps in
    // the gesture loop above). Infers the moved edge by diffing the in-progress box against the element's
    // committed start box (stable during a local resize). Rotated boxes skip (axis-aligned edges lie),
    // mirroring slides. Records the matched guide lines for the SVG overlay.
    const resizeSnapBox = useCallback(
        (b: Box): Box => {
            if (b.angle !== 0) return b;
            const id = selectedIds.length === 1 ? selectedIds[0] : null;
            if (!id) return b;
            const startEl = elementsRef.current.find((el) => el.id === id);
            if (!startEl) return b;
            const start = elementBox(startEl);
            const EPS = 0.001;
            const movedLeft = Math.abs(b.x - start.x) > EPS;
            const movedRight = Math.abs(b.x + b.width - (start.x + start.width)) > EPS;
            const movedTop = Math.abs(b.y - start.y) > EPS;
            const movedBottom = Math.abs(b.y + b.height - (start.y + start.height)) > EPS;
            let mode = 'resize-';
            if (movedTop) mode += 'n';
            else if (movedBottom) mode += 's';
            if (movedLeft) mode += 'w';
            else if (movedRight) mode += 'e';
            if (mode === 'resize-') return b; // nothing moved yet
            const { box, lines } = snapBoxToTargets(
                b,
                buildSnapTargets(new Set([id])),
                mode,
                SNAP_SCREEN_THRESHOLD / zoom,
            );
            setSnapLines(lines);
            return box;
        },
        [selectedIds, zoom, buildSnapTargets],
    );

    // Sweep zombie image placeholders left behind by a tab close or reload mid-upload (vector adopts
    // the shared sweep). This canvas mounts only after the doc syncs, so mount IS the ready signal, and
    // this tab's own uploads start on later user action — never in the mount snapshot. Snapshot pending
    // element ids, re-check pending at removal (another tab may have completed the upload in the window),
    // and delete the survivors in ONE untracked transact — a sweep must never be undoable.
    useZombieMediaSweep({
        ready: true,
        scan: () =>
            elementsRef.current
                .filter((el) => el.type === 'image' && isPendingMediaName(el.mediaName))
                .map((el) => el.id),
        remove: (ids) => {
            const stale = ids.filter((id) => {
                const el = elementsRef.current.find((e) => e.id === id);
                return el?.type === 'image' && isPendingMediaName(el.mediaName);
            });
            if (stale.length) deleteElementsUntracked(stale);
        },
    });

    const healTextDims = useCallback(
        (id: string, text: string, fontSize: number, fontFamily: string) => {
            if (isVectorFontLoaded(fontSize, fontFamily)) return;
            loadVectorFont(fontSize, fontFamily)
                .then(() => {
                    const el = elementsRef.current.find((x) => x.id === id);
                    if (el?.type !== 'text' && el?.type !== 'arrow') return; // deleted meanwhile — nothing to heal
                    if (el.text !== text || el.fontSize !== fontSize || el.fontFamily !== fontFamily) return;
                    const healed = measureVectorText(text, fontSize, fontFamily);
                    // A text element stores width + height; an arrow's label height derives from its line
                    // count, so only labelWidth is measured (the sole width source, like text elements' width).
                    if (el.type === 'arrow') {
                        if (healed.width === el.labelWidth) return;
                        undoManager?.stopCapturing();
                        updateElement(id, { labelWidth: healed.width });
                        undoManager?.stopCapturing();
                        return;
                    }
                    if (healed.width === el.width && healed.height === el.height) return;
                    undoManager?.stopCapturing();
                    updateElement(id, { width: healed.width, height: healed.height });
                    undoManager?.stopCapturing();
                })
                .catch(() => {});
        },
        [updateElement, undoManager],
    );

    // One editing session → exactly one Yjs write (or zero for an empty new element). stopCapturing
    // on both sides so the session is its own undo step. The measurement util is the sole writer of
    // the stored width/height. Read the live session from a ref (not a closure) so the callback stays
    // stable and side effects run once, never inside a state updater.
    const commitEditing = useCallback(
        (text: string) => {
            const ed = editingRef.current;
            editingRef.current = null;
            setEditing(null);
            if (!ed) return;
            const empty = text.trim().length === 0;
            if (ed.kind === 'arrow') {
                // The arrow already exists — write the label in place: `text` + measured `labelWidth`
                // (height derives from the line count) in one sealed transact. An empty label
                // clears both to ''/0 and never deletes the arrow; a still-empty label is a no-op.
                // updateElement no-ops on a Yjs map the arrow's remote deletion already removed.
                if (!(ed.isNew && empty)) {
                    const labelWidth = empty ? 0 : measureVectorText(text, ed.fontSize, ed.fontFamily).width;
                    undoManager?.stopCapturing();
                    updateElement(ed.id, { text: empty ? '' : text, labelWidth });
                    undoManager?.stopCapturing();
                    if (!empty) healTextDims(ed.id, text, ed.fontSize, ed.fontFamily);
                }
                setSelectedIds([ed.id]);
                setTool('select');
                return;
            }
            if (ed.isNew) {
                if (!empty) {
                    const { width, height } = measureVectorText(text, ed.fontSize, ed.fontFamily);
                    undoManager?.stopCapturing();
                    // One addElement transact. Per-field LWW on concurrent text edits is accepted v1
                    // (same as slides' text object): the later commit wins the `text` field whole.
                    const id = addElement({
                        type: 'text',
                        x: ed.x,
                        y: ed.y,
                        width,
                        height,
                        text,
                        fontSize: ed.fontSize,
                        fontFamily: ed.fontFamily,
                        textAlign: ed.textAlign,
                    });
                    undoManager?.stopCapturing();
                    if (id) {
                        setSelectedIds([id]);
                        healTextDims(id, text, ed.fontSize, ed.fontFamily);
                    }
                }
                // empty → zero Yjs writes, no element, no undo step
            } else if (empty) {
                undoManager?.stopCapturing();
                deleteElements([ed.id]);
                undoManager?.stopCapturing();
                setSelectedIds([]);
            } else {
                const { width, height } = measureVectorText(text, ed.fontSize, ed.fontFamily);
                undoManager?.stopCapturing();
                updateElement(ed.id, { text, width, height }); // per-field LWW, accepted v1
                undoManager?.stopCapturing();
                setSelectedIds([ed.id]);
                healTextDims(ed.id, text, ed.fontSize, ed.fontFamily);
            }
            // A text-tool session reverts to select (a double-click session was already select); the tool
            // lock keeps the text tool active for repeated placement.
            if (!toolLocked) setTool('select');
        },
        [addElement, updateElement, deleteElements, undoManager, setSelectedIds, setTool, toolLocked, healTextDims],
    );

    // A paste carries no coordinates (unlike a drop), so it anchors on the visible viewport center.
    const viewportCenterScene = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return { x: 0, y: 0 };
        return clientToScene(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }, [clientToScene, containerRef]);

    // Natural-size boxes for a batch of images: each fits within the visible viewport (uniform,
    // never upscale), centred on `anchor`, cascading +20,+20 per item — shared by every insert path.
    const imagePlacements = useCallback(
        (intrinsics: (ImageSize | null)[], anchor: { x: number; y: number }) => {
            const rect = containerRef.current?.getBoundingClientRect();
            const view = { width: (rect?.width ?? 0) / zoom, height: (rect?.height ?? 0) / zoom };
            return intrinsics.map((intrinsic, i) => {
                const { width, height } = fitImageSize(intrinsic, view);
                const off = i * IMAGE_CASCADE_OFFSET;
                return { x: anchor.x + off - width / 2, y: anchor.y + off - height / 2, width, height };
            });
        },
        [containerRef, zoom],
    );

    // Drop/paste image(s) → upload into media/ and place each at natural size, centered on `anchor`
    // (a multi-file drop cascades +20,+20). Sizes are measured up-front so the adds run as one tight
    // synchronous batch = one undo step (an await between adds could split it past the UndoManager's
    // capture window). Each optimistic element renders instantly from the pending blob URL; the
    // pending → real mediaName swap is its own late transact (mirrors slides), and useUploadFile
    // owns the failure toast.
    const insertImageFiles = useCallback(
        async (files: File[], anchor: { x: number; y: number }) => {
            if (!mediaFolderId) return; // no upload target — nothing to do
            const images = files.filter((f) => f.type.startsWith('image/'));
            if (!images.length) return;
            const measured = await Promise.all(
                // readImageSize → null for a file with no intrinsic size (e.g. an SVG); fitImageSize
                // maps null → the default box (viewport-capped), so the file is placed, not dropped.
                images.map(async (file) => ({ file, intrinsic: await readImageSize(file) })),
            );

            const boxes = imagePlacements(
                measured.map((m) => m.intrinsic),
                anchor,
            );

            undoManager?.stopCapturing();
            const pending: { id: string; promise: Promise<DrivePath | null> }[] = [];
            for (const [i, { file }] of measured.entries()) {
                const { pendingName, promise } = startUpload(file);
                const id = addElement({ type: 'image', ...boxes[i], mediaName: pendingName });
                if (id) pending.push({ id, promise });
            }
            undoManager?.stopCapturing(); // trailing seal — the whole batch is one undo step
            setSelectedIds(pending.map((p) => p.id));

            for (const { id, promise } of pending) {
                promise
                    // Untracked swap: the drop's insert stays the sole undo step (one ⌘Z), same as the
                    // cross-mount paste path; peers still receive the real name.
                    .then((result) =>
                        result ? updateElementUntracked(id, { mediaName: result.name }) : deleteElementsUntracked([id]),
                    )
                    .catch(() => {});
            }
        },
        [
            mediaFolderId,
            imagePlacements,
            startUpload,
            addElement,
            updateElementUntracked,
            deleteElementsUntracked,
            setSelectedIds,
            undoManager,
        ],
    );

    // Drive-picked images: copy into media/, measure, then place all at natural size around the
    // viewport centre in ONE transact = one undo step. Measuring goes by the copy result's own path —
    // by NAME it would miss the pre-copy media listing (the slides idiom).
    const insertDrivePaths = useCallback(
        async (paths: DrivePath[]) => {
            if (!mediaFolderId) return;
            const results = await copyToMediaFolder({ paths, mediaFolderId }).catch(() => null);
            if (!results?.length) return;
            const measured = await Promise.all(
                results.map(async (result) => ({
                    name: result.name,
                    intrinsic: await readImageSizeFromUrl(resolveMediaUrlByPath(result)),
                })),
            );
            const boxes = imagePlacements(
                measured.map((m) => m.intrinsic),
                viewportCenterScene(),
            );
            undoManager?.stopCapturing();
            const ids = addElements(
                measured.map(({ name }, i) => ({ type: 'image' as const, ...boxes[i], mediaName: name })),
            );
            undoManager?.stopCapturing(); // trailing seal — the whole batch is one undo step
            setSelectedIds(ids);
        },
        [
            mediaFolderId,
            copyToMediaFolder,
            resolveMediaUrlByPath,
            viewportCenterScene,
            imagePlacements,
            addElements,
            undoManager,
            setSelectedIds,
        ],
    );

    // Publish the insert surface for the toolbar (cleared on unmount so a stale canvas never places).
    useEffect(() => {
        if (!imageInsertRef) return;
        imageInsertRef.current = {
            insertFiles: (files) => void insertImageFiles(files, viewportCenterScene()),
            insertDrivePaths,
        };
        return () => {
            imageInsertRef.current = null;
        };
    }, [imageInsertRef, insertImageFiles, viewportCenterScene, insertDrivePaths]);

    // Image ingestion is gated on a real upload target (a fresh .eigenvector scaffolds media/, so
    // this is normally present) and is closed while a text overlay owns paste + the pointer.
    const imagesEnabled = canWrite && !!mediaFolderId && !editing;
    // The drop hook stays ALWAYS enabled so dragover/drop are always preventDefault'd — a disabled
    // hook skips that, letting the BROWSER navigate to a file dropped while read-only or mid-text-edit
    // (destroying the editor + uncommitted text). The insertion gate lives in the callback instead;
    // the drag-over affordance shows only when insertion is actually possible.
    const { targetProps: fileDropProps, isDragging } = useFileDropTarget((files, e) => {
        if (!imagesEnabled) return;
        void insertImageFiles(files, e ? clientToScene(e.clientX, e.clientY) : viewportCenterScene());
    });
    // Paste stays gated: its disabled default (no preventDefault) is harmless — text pastes flow on.
    const { onPaste } = useFilePasteTarget((files) => {
        void insertImageFiles(files, viewportCenterScene());
    }, imagesEnabled);

    // The clipboard PRODUCER (typed items + the self-contained SVG flavour) + plain-text flavor live in
    // ./tools/clipboard; the canvas calls them with the live z-order, selection, background and path resolver.
    const buildData = useCallback(
        (): EigenClipboardData => buildSelectionData(ordered, selectedIds, meta, resolveMediaPath),
        [ordered, selectedIds, meta, resolveMediaPath],
    );
    const plainText = useCallback(() => selectionPlainText(ordered, selectedIds), [ordered, selectedIds]);

    // Element clipboard CONSUMER: eigen items → new elements. Images size from the TYPED width/height
    // (authoritative; angle applied; cross-mount re-uploads into our media/ then swaps the pending name
    // in a late transact). Text re-measures its dims LOCALLY (typed size is never written onto text) and
    // self-heals once the face loads. Shapes rebuild from meta.vector. All ADDS run in ONE transact; the
    // set is re-anchored on the viewport centre preserving each element's relative offset.
    const pasteEigenItems = useCallback(
        (items: EigenClipboardItem[]) => {
            if (!items.length) return;
            const anchor = viewportCenterScene();

            // Translate the vector-origin items (those carrying scene coords) so their bounding-box
            // centre lands on the viewport; cross-app items (no meta.vector) cascade from the anchor.
            const positioned = items.map((item) => ({ item, meta: readVectorMeta(item), box: readClipboardBox(item) }));
            const withCoords = positioned.filter(
                (p): p is typeof p & { meta: NonNullable<typeof p.meta> } => p.meta != null,
            );
            let dx = 0;
            let dy = 0;
            if (withCoords.length) {
                let minX = Number.POSITIVE_INFINITY;
                let minY = Number.POSITIVE_INFINITY;
                let maxX = Number.NEGATIVE_INFINITY;
                let maxY = Number.NEGATIVE_INFINITY;
                for (const { meta, box } of withCoords) {
                    minX = Math.min(minX, meta.x);
                    minY = Math.min(minY, meta.y);
                    maxX = Math.max(maxX, meta.x + box.width);
                    maxY = Math.max(maxY, meta.y + box.height);
                }
                dx = anchor.x - (minX + maxX) / 2;
                dy = anchor.y - (minY + maxY) / 2;
            }

            const partials: NewVectorElement[] = [];
            const textHeals: { index: number; text: string; fontSize: number; fontFamily: string }[] = [];
            const crossMount: { index: number; item: EigenClipboardImageItem }[] = [];
            // Each pasted element's partial index → its source id (for the remap map), and the arrows whose
            // bindings are remapped across the pasted set once the clones have ids.
            const cloneIds = new Map<number, string>();
            const arrowRemaps: PastedArrow[] = [];
            let cascade = 0;
            const placeAt = (meta: VectorClipMeta | null, w: number, h: number) => {
                if (meta) return { x: meta.x + dx, y: meta.y + dy };
                const off = cascade * IMAGE_CASCADE_OFFSET;
                cascade += 1;
                return { x: anchor.x - w / 2 + off, y: anchor.y - h / 2 + off };
            };

            for (const { item, meta, box } of positioned) {
                const angle = box.angle ?? 0;
                if (item.type === 'image') {
                    const w = box.width;
                    const h = box.height;
                    const pos = placeAt(meta, w, h);
                    const index = partials.length;
                    if (needsReUpload(item.sourceParentId, mediaFolderId) && mediaFolderId) {
                        // Optimistic add with a pending name; the real name swaps in a late transact.
                        partials.push({
                            type: 'image',
                            ...pos,
                            width: w,
                            height: h,
                            angle,
                            mediaName: `pending:${crypto.randomUUID()}`,
                        });
                        crossMount.push({ index, item });
                    } else {
                        partials.push({ type: 'image', ...pos, width: w, height: h, angle, mediaName: item.mediaName });
                    }
                    continue;
                }
                // Shape or linear carrier (a text item whose meta.vector names a shape/freedraw/line/arrow
                // type). A linear element additionally restores its `points` (undefined for shapes); an
                // arrow also restores its heads + label and is queued for the binding remap below.
                if (meta?.type) {
                    // A linear carrier without points would read back as nothing (read-vector drops it).
                    if ((meta.type === 'freedraw' || meta.type === 'line' || meta.type === 'arrow') && !meta.points)
                        continue;
                    const w = box.width;
                    const h = box.height;
                    const pos = placeAt(meta, w, h);
                    const index = partials.length;
                    if (meta.id) cloneIds.set(index, meta.id);
                    const partial: NewVectorElement = {
                        type: meta.type,
                        ...pos,
                        width: w,
                        height: h,
                        angle,
                        strokeColor: meta.strokeColor,
                        backgroundColor: meta.backgroundColor,
                        fillStyle: meta.fillStyle,
                        strokeStyle: meta.strokeStyle,
                        strokeWidth: meta.strokeWidth,
                        roughness: meta.roughness,
                        opacity: meta.opacity,
                        roundness: meta.roundness,
                        points: meta.points,
                    };
                    if (meta.type === 'arrow') {
                        partial.startArrowhead = meta.startArrowhead;
                        partial.endArrowhead = meta.endArrowhead;
                        partial.elbow = meta.elbow;
                        partial.fixedSegments = meta.fixedSegments;
                        partial.text = meta.text;
                        partial.fontSize = meta.fontSize;
                        partial.fontFamily = meta.fontFamily;
                        partial.labelWidth = meta.labelWidth;
                        arrowRemaps.push({
                            index,
                            startBinding: meta.startBinding ?? '',
                            endBinding: meta.endBinding ?? '',
                        });
                    }
                    partials.push(partial);
                    continue;
                }
                // Real text element — re-measure dims locally (never the wire size). An empty text
                // item is another app's contentless carrier (a shape from a foreign doc) — skip it.
                if (!clipboardTextItemHasContent(item)) continue;
                const typo = item.typography ?? {};
                const fontFamily = typo.fontFamily ?? DEFAULT_FONT_FAMILY;
                const fontSize = typo.fontSize ?? DEFAULT_FONT_SIZE;
                const textAlign = toVectorTextAlign(typo.textAlign);
                const { width: w, height: h } = measureVectorText(item.text, fontSize, fontFamily);
                const pos = placeAt(meta, w, h);
                textHeals.push({ index: partials.length, text: item.text, fontSize, fontFamily });
                partials.push({
                    type: 'text',
                    ...pos,
                    width: w,
                    height: h,
                    angle,
                    text: item.text,
                    fontSize,
                    fontFamily,
                    textAlign,
                    strokeColor: meta?.strokeColor,
                    backgroundColor: meta?.backgroundColor,
                    opacity: meta?.opacity,
                });
            }

            if (!partials.length) return;
            undoManager?.stopCapturing();
            const ids = addElements(partials); // ONE transact for all adds
            // Remap each pasted arrow's bindings now that the clones have ids — no stopCapturing between the
            // add and this update, so the whole paste stays ONE undo step.
            const remap = remapPastedArrows(arrowRemaps, cloneIds, ids);
            if (remap.length) updateElements(remap);
            undoManager?.stopCapturing();
            if (!ids.length) return;
            setSelectedIds(ids);

            // Text: heal dims once the face resolves (late transact each, self-sealing + live-validated).
            for (const { index, text, fontSize, fontFamily } of textHeals) {
                const id = ids[index];
                if (id) healTextDims(id, text, fontSize, fontFamily);
            }
            // Cross-mount images: fetch from source, re-upload into our media/, swap the pending name
            // (late transact) or drop the element on failure — the shipped M4 optimistic-insert idiom.
            for (const { index, item } of crossMount) {
                const id = ids[index];
                if (!id || !mediaFolderId) continue;
                reUploadImage(
                    item.sourcePathId,
                    item.sourceOwnerId,
                    item.sourceMountId,
                    mediaFolderId,
                    uploadFile.mutateAsync,
                    item.mediaName,
                )
                    .then((result) => {
                        if (!result) {
                            deleteElementsUntracked([id]);
                            return;
                        }
                        // Untracked: this technical swap is NOT its own undo step, so the whole
                        // cross-mount paste is a single ⌘Z (reverts the insert; peers converge via its
                        // inverse). Redo re-adds the element at its recorded pending name — the same
                        // accepted optimistic-insert redo edge as the sheets fix.
                        updateElementUntracked(id, { mediaName: result.mediaName });
                    })
                    .catch(() => {});
            }
        },
        [
            viewportCenterScene,
            mediaFolderId,
            addElements,
            updateElements,
            setSelectedIds,
            undoManager,
            healTextDims,
            updateElementUntracked,
            deleteElementsUntracked,
            uploadFile.mutateAsync,
        ],
    );

    // Plain-text paste (no eigen payload, no OS files) → ONE text element at the viewport centre, with
    // default typography and locally-measured dims (the pasteEigenItems text idiom). Multi-line text is
    // preserved — measureVectorText and the renderer both split on \n. One sealed undo step.
    const pasteTextElement = useCallback(
        (text: string, textAlign: TextAlign = 'left') => {
            const anchor = viewportCenterScene();
            const { width: w, height: h } = measureVectorText(text, DEFAULT_FONT_SIZE, DEFAULT_FONT_FAMILY);
            undoManager?.stopCapturing();
            const id = addElement({
                type: 'text',
                x: anchor.x - w / 2,
                y: anchor.y - h / 2,
                width: w,
                height: h,
                angle: 0,
                text,
                fontSize: DEFAULT_FONT_SIZE,
                fontFamily: DEFAULT_FONT_FAMILY,
                textAlign,
            });
            undoManager?.stopCapturing();
            if (!id) return;
            setSelectedIds([id]);
            healTextDims(id, text, DEFAULT_FONT_SIZE, DEFAULT_FONT_FAMILY);
        },
        [viewportCenterScene, addElement, setSelectedIds, undoManager, healTextDims],
    );

    // Non-eigen text paste (the keyboard fallthrough and the async menu path share this policy): plain
    // text, or the flattened text of pasted HTML, becomes one text element. Prose alignment rides in
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
    // canWrite && !editing; isTypingTarget() bails so the text overlay + a comments composer keep native
    // clipboard (the typing-target invariant). Eigen items are consumed FIRST; a non-eigen paste falls
    // through (capture phase, no stopPropagation) to the container's useFilePasteTarget for OS files.
    useEffect(() => {
        const onCopyEvent = (e: ClipboardEvent) => {
            if (isTypingTarget() || !canWrite || editingRef.current || selectedIds.length === 0) return;
            const data = buildData();
            if (!data.items.length) return;
            e.preventDefault();
            writeEigenClipboard(e, data, plainText());
        };
        const onCutEvent = (e: ClipboardEvent) => {
            if (isTypingTarget() || !canWrite || editingRef.current || selectedIds.length === 0) return;
            const data = buildData();
            if (!data.items.length) return;
            e.preventDefault();
            writeEigenClipboard(e, data, plainText());
            // One sealed undo step (deleteSelection stopCaptures on both sides).
            deleteSelection(selectedIds, deleteElements, setSelectedIds, undoManager);
        };
        const onPasteEvent = (e: ClipboardEvent) => {
            if (isTypingTarget() || !canWrite || editingRef.current) return;
            const cd = e.clipboardData;
            const data = cd ? readEigenClipboard(cd) : null;
            if (data) {
                e.preventDefault();
                e.stopPropagation();
                pasteEigenItems(data.items);
                return;
            }
            if (!cd) return;
            // A bare SVG on the clipboard: ours (element JSON in `<metadata>`) restores native elements;
            // any other SVG inserts as an image via the media path. OS files still fall through.
            const svg = readSvgClipboard(cd);
            if (svg) {
                e.preventDefault();
                e.stopPropagation();
                const restored = extractClipboardSvgMetadata(svg);
                if (restored) pasteEigenItems(restored.items);
                else void insertImageFiles([svgToImageFile(svg)], viewportCenterScene());
                return;
            }
            // No eigen/SVG payload. OS files fall through to useFilePasteTarget (image drop path).
            if (cd.files.length > 0) return;
            // Plain text (or the text of pasted HTML) → a new text element; only claim the event when
            // content is actually consumed, else it falls through to the OS-file path.
            if (pasteNonEigenText(cd.getData('text/html'), cd.getData('text/plain'))) {
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
    }, [
        canWrite,
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
    ]);

    const onDoubleClick = (e: React.MouseEvent) => {
        // frozenRef: no new session over a live gesture. Empty canvas → new text (Excalidraw's openNewText); else edit the hit text/arrow label.
        if (!canWrite || tool !== 'select' || editing || frozenRef.current) return;
        const p = clientToScene(e.clientX, e.clientY);
        const hit = hitTestTopmost(ordered, p, zoom, committedById);
        const hitEl = hit ? ordered.find((el) => el.id === hit) : undefined;
        if (hitEl?.type === 'text') openEditExisting(hitEl);
        else if (hitEl?.type === 'arrow') openEditArrowLabel(hitEl);
        else if (!hitEl) openNewText(p.x, p.y);
    };

    // Right-click on an element opens the object menu (empty canvas keeps the browser default). Like
    // slides, a right-click on an element outside the current selection selects it first, so the menu
    // ops act on the target; a right-click inside the selection keeps the whole selection. The canvas
    // uses hit-testing (elements have no per-node DOM), so this lives on the container, not per object.
    const onContextMenu = (e: React.MouseEvent) => {
        // frozenRef: no menu over a live left-button gesture (marquee/move keeps its capture).
        if (!canWrite || editing || frozenRef.current) return;
        // A multi-point draft runs unfrozen but still owns the pointer: no menu (object or browser)
        // mid-draft — the draft keeps floating and the next left click keeps placing points.
        if (drawing.multiPointDraft) {
            e.preventDefault();
            return;
        }
        const p = clientToScene(e.clientX, e.clientY);
        const hitId = hitTestTopmost(ordered, p, zoom, committedById);
        if (!hitId) return;
        if (!selectedIds.includes(hitId)) setSelectedIds([hitId]);
        objectContextMenu.handleContextMenu(e, hitId);
    };

    // Menu ops act on the full selection, wired to the same writes as ⌘[/] , ⌘D, and Delete so the
    // menu and the keyboard stay one behavior (one sealed undo step each).
    const onMenuArrange = (op: ZOp) => applyZOrder(op, elements, selectedIds, updateElements, undoManager);
    const onMenuDuplicate = () => duplicateSelection(selectedIds, duplicateElements, setSelectedIds, undoManager);
    const onMenuDelete = () => deleteSelection(selectedIds, deleteElements, setSelectedIds, undoManager);
    // Menu clipboard rows: no ClipboardEvent here, so copy/cut go through the async writer and paste
    // through the async reader (eigen items only — OS files still need ⌘V). Same producer/consumer as
    // the keyboard path, so the two stay one behavior.
    const onMenuCopy = () => {
        const data = buildData();
        if (data.items.length) writeEigenClipboardAsync(data, plainText()).catch(() => {});
    };
    const onMenuCut = () => {
        const data = buildData();
        if (!data.items.length) return;
        // Delete only once the async write lands — a denied/failed clipboard write must not destroy
        // the selection (the content would exist nowhere but the undo stack).
        writeEigenClipboardAsync(data, plainText())
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

    const onPointerDown = (e: React.PointerEvent) => {
        if (frozenRef.current) return; // a gesture is already active (defensive)
        // Focus the tabIndex=-1 container so a following paste lands on our onPaste — a bare canvas
        // div never holds focus, so image paste would otherwise bubble past us to the body.
        containerRef.current?.focus();
        // Pan: space-drag or middle mouse.
        if (spaceHeld || e.button === 1) {
            e.preventDefault();
            containerRef.current?.setPointerCapture(e.pointerId);
            frozenRef.current = true;
            setPanning(true);
            gestureRef.current = { kind: 'pan', pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
            return;
        }
        if (e.button !== 0) return;
        if (!canWrite) return;

        const p = clientToScene(e.clientX, e.clientY);

        // Freehand / line / eraser own their own gesture (local state + capture); the hook consumes
        // the event for those tools and the canvas does nothing more.
        if (drawing.onPointerDown(e, p)) return;

        // Text tool: click places a caret (no drag-create, no capture). A click that hits an existing
        // text element edits THAT element instead of stacking a fresh empty on top.
        if (tool === 'text') {
            // Cancel the pointerdown: the compatibility mousedown fires AFTER this dispatch (and
            // after the overlay mounts + focuses its textarea), and its focus default re-hit-tests
            // at the cursor — which sits exactly on the new textarea's top-left boundary pixel. A
            // miss lands on this non-focusable div, blurs the textarea, and the blur-commit
            // discards the empty session instantly (intermittent dead clicks). Canceling also
            // keeps mousedown's caret-placement from destroying the select-all on existing text.
            e.preventDefault();
            const hit = hitTestTopmost(ordered, p, zoom, committedById);
            const hitEl = hit ? ordered.find((el) => el.id === hit) : undefined;
            if (hitEl?.type === 'text') openEditExisting(hitEl);
            else openNewText(p.x, p.y);
            return;
        }

        containerRef.current?.setPointerCapture(e.pointerId);

        // Shape tool → start a local (not-yet-Yjs) drag-create. (Freehand/line/eraser already
        // returned via the tools hook; text was handled above.)
        if (tool === 'rectangle' || tool === 'diamond' || tool === 'ellipse') {
            frozenRef.current = true;
            undoManager?.stopCapturing();
            setSelectedIds([]);
            gestureRef.current = { kind: 'create', pointerId: e.pointerId, startX: p.x, startY: p.y };
            setCreating({
                type: tool,
                seed: Math.floor(Math.random() * 2 ** 31),
                box: { x: p.x, y: p.y, width: 0, height: 0, angle: 0 },
            });
            return;
        }

        // Select tool.
        const hitId = hitTestTopmost(ordered, p, zoom, committedById);
        if (hitId) {
            if (e.shiftKey) {
                toggle(hitId); // shift-click toggles membership, no move
                return;
            }
            const ids = selectedIds.includes(hitId) ? selectedIds : [hitId];
            if (!selectedIds.includes(hitId)) setSelectedIds([hitId]);
            const originals: Record<string, { x: number; y: number }> = {};
            const selById = new Map<string, VectorElement>();
            for (const id of ids) {
                const el = ordered.find((x) => x.id === id);
                if (el) {
                    originals[id] = { x: el.x, y: el.y };
                    selById.set(id, el);
                }
            }
            frozenRef.current = true;
            undoManager?.stopCapturing();
            gestureRef.current = {
                kind: 'move',
                pointerId: e.pointerId,
                startX: p.x,
                startY: p.y,
                originals,
                ids,
                moved: false,
                selById,
                snapTargets: buildSnapTargets(new Set(ids)),
            };
            return;
        }

        // Empty space → marquee (Shift = additive; else clear first, then select contained).
        frozenRef.current = true;
        const additive = e.shiftKey;
        if (!additive) setSelectedIds([]);
        gestureRef.current = {
            kind: 'marquee',
            pointerId: e.pointerId,
            startX: p.x,
            startY: p.y,
            additive,
            base: additive ? selectedIds : [],
        };
        setMarquee({ box: { x: p.x, y: p.y, width: 0, height: 0, angle: 0 }, mode: 'contain' });
    };

    const onPointerMove = (e: React.PointerEvent) => {
        // Publish the local cursor on every move (throttled downstream; no React state → no
        // re-render), then handle the active gesture if any.
        const scene = clientToScene(e.clientX, e.clientY);
        publishCursor(scene);
        const g = gestureRef.current;
        // Pan first: a multi-point line draft leaves the surface unfrozen, so a space-pan can start
        // mid-polyline and must keep driving over the draft's trailing point.
        if (g?.kind === 'pan') {
            if (e.pointerId !== g.pointerId) return;
            panBy(e.clientX - g.lastX, e.clientY - g.lastY);
            g.lastX = e.clientX;
            g.lastY = e.clientY;
            return;
        }
        // A freehand stroke / eraser swipe / line draft (incl. its hover trailing point) is handled by
        // the tools hook, which consumes the move.
        if (drawing.onPointerMove(e)) return;
        // Hover affordance (idle select): one hitTestTopmost on this same move path (no separate scanner) flips the `move` cursor; a gesture never pays for it.
        if (!g && tool === 'select' && !editing) {
            const over = hitTestTopmost(ordered, scene, zoom, committedById) !== null;
            if (over !== hoveringSelectable) setHoveringSelectable(over);
        }
        if (!g || e.pointerId !== g.pointerId) return;
        const p = scene;
        if (g.kind === 'create') {
            let dx = p.x - g.startX;
            let dy = p.y - g.startY;
            if (e.shiftKey) {
                // Square/circle: the dominant axis wins.
                const s = Math.max(Math.abs(dx), Math.abs(dy));
                dx = (Math.sign(dx) || 1) * s;
                dy = (Math.sign(dy) || 1) * s;
            }
            setCreating((c) => (c ? { ...c, box: newShapeBox(g.startX, g.startY, dx, dy, e.altKey) } : c));
            return;
        }
        if (g.kind === 'move') {
            let dx = p.x - g.startX;
            let dy = p.y - g.startY;
            if (e.shiftKey) {
                // Dominant-axis lock.
                if (Math.abs(dx) < Math.abs(dy)) dx = 0;
                else dy = 0;
            }
            if (dx !== 0 || dy !== 0) g.moved = true;

            const selById = g.selById;
            const selEls = [...selById.values()];
            // Snap the selection's AABB to the other elements (centre-only if any member is rotated —
            // Override-24), then apply the snap correction to every moved element. Empty lines = no snap.
            // A Shift-locked axis (the zeroed one) is passed to snap as lockAxis so it never produces a
            // correction or guide line to undo here.
            let snapDx = 0;
            let snapDy = 0;
            if (selEls.length > 0) {
                const b = getElementsBounds(selEls.map((el) => ({ ...elementBox(el), x: el.x + dx, y: el.y + dy })));
                const anyRotated = selEls.some((el) => el.angle !== 0);
                const lockAxis = e.shiftKey ? (dx === 0 ? 'x' : 'y') : undefined;
                const { box: snapped, lines } = snapBoxToTargets(
                    boundsToBox(b),
                    g.snapTargets,
                    'move',
                    SNAP_SCREEN_THRESHOLD / zoom,
                    anyRotated,
                    lockAxis,
                );
                snapDx = snapped.x - b.minX;
                snapDy = snapped.y - b.minY;
                setSnapLines(lines);
            }

            const next: Record<string, Box> = {};
            for (const id of g.ids) {
                const o = g.originals[id];
                const el = selById.get(id);
                if (!o || !el) continue;
                next[id] = {
                    x: o.x + dx + snapDx,
                    y: o.y + dy + snapDy,
                    width: el.width,
                    height: el.height,
                    angle: el.angle,
                };
            }
            setPreviews(next);
            return;
        }
        // marquee — direction picks the mode (rightward = contain, leftward = intersect), resolved
        // from the raw start/current x before normalizeRect drops the direction.
        const box = normalizeRect(g.startX, g.startY, p.x, p.y);
        const mode = marqueeMode(g.startX, p.x);
        setMarquee({ box, mode });
        const hits = marqueeSelect(ordered, boxToBounds(box), mode, committedById);
        setSelectedIds(g.additive ? [...new Set([...g.base, ...hits])] : hits);
    };

    const finishGesture = (altKey = false) => {
        const g = gestureRef.current;
        // No active gesture → nothing to finish, and crucially DON'T touch frozenRef: a text session
        // freezes the viewport with no gesture, and this handler runs on the session's opening
        // pointerup (and on every caret click inside the textarea, which bubbles up here). Clearing
        // the freeze here was letting wheel zoom/pan the scene out from under the overlay — the
        // root cause of the editing-freeze leak. Only a real gesture unfreezes.
        if (!g) return;
        gestureRef.current = null;
        frozenRef.current = false;

        if (g.kind === 'pan') {
            setPanning(false);
            return;
        }
        if (g.kind === 'create') {
            const c = creating;
            setCreating(null);
            if (!toolLocked) setTool('select');
            if (c && (c.box.width >= CREATE_MIN_SIZE || c.box.height >= CREATE_MIN_SIZE)) {
                const id = addElement({
                    type: c.type,
                    x: c.box.x,
                    y: c.box.y,
                    width: Math.max(MIN_ELEMENT_SIZE, c.box.width),
                    height: Math.max(MIN_ELEMENT_SIZE, c.box.height),
                    seed: c.seed,
                });
                if (id) setSelectedIds([id]);
                // Trailing seal: a nudge inside the 500ms capture window must not merge into
                // this gesture's undo step (nudges deliberately carry no leading stopCapturing).
                undoManager?.stopCapturing();
            }
            return;
        }
        if (g.kind === 'move') {
            if (g.moved) {
                // Alt-drag duplicate (slides' idiom): clones materialize at gesture END in ONE transact
                // (the drag only ever showed local preview ghosts — no Yjs write happened yet), so it's
                // a single undo step and the originals stay put. Plain drag commits the move.
                const anchor = g.ids.find((id) => previews[id] && g.originals[id]);
                const dx = anchor ? previews[anchor].x - g.originals[anchor].x : 0;
                const dy = anchor ? previews[anchor].y - g.originals[anchor].y : 0;
                if (altKey && (dx !== 0 || dy !== 0)) {
                    const ids = duplicateElements(g.ids, dx, dy);
                    undoManager?.stopCapturing(); // trailing seal (leading seal fired at pointerdown)
                    if (ids.length) setSelectedIds(ids);
                } else {
                    // Past the unbind threshold, a dragged arrow detaches from any bound shape left behind
                    // (a shape dragged along stays bound — updateElements re-snaps it).
                    const movedIds = new Set(g.ids);
                    const farEnough = Math.hypot(dx, dy) * zoom >= ARROW_UNBIND_SCREEN;
                    const patches = g.ids
                        .filter((id) => previews[id])
                        .map((id) => {
                            const el = elementsRef.current.find((e) => e.id === id);
                            const fields: VectorElementPatch = { x: previews[id].x, y: previews[id].y };
                            if (farEnough && el?.type === 'arrow')
                                Object.assign(fields, unbindDraggedArrow(el, movedIds));
                            return { id, fields };
                        });
                    if (patches.length) updateElements(patches);
                    undoManager?.stopCapturing(); // trailing seal, same as create
                }
            }
            setPreviews({});
            setSnapLines([]);
            return;
        }
        // marquee: selection was set live during the move; a plain click already cleared it.
        setMarquee(null);
    };
    finishRef.current = finishGesture;

    const onPointerUp = (e: React.PointerEvent) => {
        const g = gestureRef.current;
        // A freehand/line/eraser gesture finishes (writes) through the tools hook; a pan (the one canvas
        // gesture that can coexist with a line draft) ends here.
        if (g?.kind !== 'pan' && drawing.onPointerUp(e)) return;
        if (g && e.pointerId !== g.pointerId) return;
        // Read Alt off the terminal event (drop-time modifier) for Alt-drag duplicate.
        finishGesture(e.altKey);
    };

    const selectedRender = ordered.filter((el) => selectedIds.includes(el.id)).map(renderEl);
    const single = selectedRender.length === 1 ? selectedRender[0] : null;
    // elementBounds is arrow-aware, so the union ring encloses a labeled arrow's overhang and an
    // elbow arrow's routed bends (arrowRoute, preview-aware via renderById).
    const unionBox =
        selectedRender.length >= 1
            ? boundsToBox(selectedRender.map((el) => elementBounds(el, arrowRoute(el, renderById))).reduce(unionBounds))
            : null;
    // No ObjectTransform box (no ring/grips/rotate grip) for a single 2-point line/arrow OR any ELBOW arrow —
    // the round endpoint dots (and, for an elbow, the pin dots) are its whole affordance. The elbow gate keys
    // on `elbow`, NOT the stored point count: a pinned elbow stores its full polyline (>2 points), and stale
    // pre-collapse data can too, yet an elbow must never mount the box. 3+-point straight linears keep the box.
    const singleLinear2pt =
        single !== null &&
        (single.type === 'line' || single.type === 'arrow') &&
        ((single.type === 'arrow' && single.elbow) || parsePoints(single.points).length <= 2);
    // Chrome is suppressed during a create/marquee drag (grip flicker), a vertex drag (drawing.hiddenId —
    // else a stale box lingers over the reshaping point draft), or a text overlay; a move keeps it.
    const showChrome = !creating && !marquee && !editing && !drawing.active && !drawing.hiddenId;
    const showTransform = showChrome && canWrite && single !== null && !singleLinear2pt;

    const cursor = pointerCursor({ panning, spaceHeld, tool, hoveringSelectable });
    const background = isTransparent(meta.background) ? undefined : meta.background;

    // One scene node — every render path routes through here so `byId` (an elbow arrow's route context) is
    // threaded in one place, not per callsite.
    const node = (el: VectorElement) => (
        <ElementNode key={el.id} el={el} resolveMedia={resolveMediaUrl} byId={renderById} />
    );

    return (
        // eigen-paper: the drawing surface always renders light, in dark mode too (globals.css). Its
        // paint must stay OPAQUE — a translucent tint lets the dark app surface bleed through it.
        <div
            ref={containerRef}
            tabIndex={-1}
            className="eigen-paper relative h-full w-full select-none overflow-hidden bg-background touch-none outline-none"
            style={{ cursor, backgroundColor: background }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            // Hide our cursor from peers when the pointer leaves — unless a gesture holds capture (the
            // pointer legitimately roams outside the container mid-drag).
            onPointerLeave={() => {
                if (!gestureRef.current) {
                    publishCursor(null);
                    setHoveringSelectable(false);
                    drawing.onPointerLeave();
                }
            }}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
            onPaste={onPaste}
            {...fileDropProps}
        >
            <svg className="pointer-events-none absolute inset-0 h-full w-full" xmlns={SVG_NS}>
                <g transform={groupTransform}>
                    {ordered.map((el) => {
                        // A line being vertex-dragged is drawn by the drawing preview below instead.
                        if (drawing.hiddenId === el.id) return null;
                        // The element under edit is drawn only by the overlay textarea (WYSIWYG). An
                        // arrow keeps its shaft/heads and hides just the label (render text='').
                        if (editing?.id === el.id) {
                            const isArrow = editing.kind === 'arrow' && el.type === 'arrow';
                            return isArrow ? node(renderEl({ ...el, text: '' })) : null;
                        }
                        return node(renderEl(el));
                    })}
                    {creating && node(creatingElement(creating))}
                    {/* Live freehand/line draft, or a point-edit reshape — the SAME elementToSvg path. */}
                    {drawing.previewElement && node(drawing.previewElement)}
                    <SnapGuides lines={snapLines} />
                    {/* Bind-target chrome — SVG in the scene group, so it rides rotation/roundness/zoom. */}
                    {drawing.bindingOutline}
                    {drawing.snapDots}
                    {drawing.focusIndicators}
                </g>
            </svg>
            <div className="pointer-events-none absolute inset-0">
                {showTransform && single && (
                    <ObjectTransform
                        box={elementBox(single)}
                        boxToStyle={boxToStyle}
                        screenDeltaToScene={screenDeltaToScene}
                        showRotate
                        // Text has derived dims + no wrap, so only corners, aspect ALWAYS locked
                        // regardless of the checkbox; a resize maps the width ratio → fontSize, then
                        // re-measures (see onCommit). Every other type follows the shared aspect lock:
                        // 'aspect-default' (Shift frees) when checked, else 'free'.
                        resizeMode={single.type === 'text' ? 'aspect' : aspectLocked ? 'aspect-default' : 'free'}
                        minSize={MIN_ELEMENT_SIZE}
                        snapBox={resizeSnapBox}
                        onTransform={(next) => {
                            if (!transformStartedRef.current) {
                                transformStartedRef.current = true;
                                frozenRef.current = true;
                                undoManager?.stopCapturing();
                            }
                            setPreviews({ [single.id]: next });
                        }}
                        onCommit={(next, start) => {
                            transformStartedRef.current = false;
                            frozenRef.current = false;
                            // Write only the fields the gesture changed — a rotate must not clobber
                            // a peer's concurrent move/resize with its stale snapshot values.
                            const fields: VectorElementPatch = {};
                            if (next.x !== start.x) fields.x = next.x;
                            if (next.y !== start.y) fields.y = next.y;
                            if (next.angle !== start.angle) fields.angle = next.angle;
                            if (single.type === 'text') {
                                // Resize scales fontSize by the width ratio, then RE-MEASURES the
                                // dims at that size — never the Box arithmetic dims (they'd drift off
                                // the renderer's layout). The measurement util is the only dim writer.
                                if (next.width !== start.width && start.width > 0) {
                                    const size = clampFontSize(single.fontSize * (next.width / start.width));
                                    const { width, height } = measureVectorText(single.text, size, single.fontFamily);
                                    fields.fontSize = size;
                                    fields.width = width;
                                    fields.height = height;
                                    healTextDims(single.id, single.text, size, single.fontFamily);
                                }
                            } else if (isLinearElement(single)) {
                                // A linear element rescales its points to the new box through resizeLinear,
                                // reading the COMMITTED element so the total scale is exact.
                                if (next.width !== start.width || next.height !== start.height) {
                                    const base = elementsRef.current.find((b) => b.id === single.id);
                                    if (base && isLinearElement(base)) {
                                        const r = resizeLinear(base, next);
                                        fields.width = r.width;
                                        fields.height = r.height;
                                        fields.points = r.points;
                                    }
                                }
                            } else {
                                if (next.width !== start.width) fields.width = next.width;
                                if (next.height !== start.height) fields.height = next.height;
                            }
                            if (Object.keys(fields).length) {
                                updateElement(single.id, fields);
                                undoManager?.stopCapturing(); // trailing seal, same as create/move
                            }
                            setPreviews({});
                            setSnapLines([]);
                        }}
                    />
                )}
                {/* Round vertex handles: over the box for a 3+-point linear, the sole chrome for a 2-point one. */}
                {drawing.handles}
                {/* Dashed union ring for multi-select + read-only single selections; a writable 2-point line/arrow shows only its handles. */}
                {showChrome && !showTransform && unionBox && !(singleLinear2pt && canWrite) && (
                    <div
                        className="eigen-selection-ring eigen-selection-ring-dashed pointer-events-none absolute"
                        style={boxToStyle(unionBox)}
                    />
                )}
                {marquee && (
                    <div
                        className={cn(
                            'pointer-events-none absolute border border-selection-handle/70 bg-selection-handle/10',
                            marquee.mode === 'intersect' && 'border-dashed',
                        )}
                        style={boxToStyle(marquee.box)}
                    />
                )}
                {editing && (
                    <TextOverlay
                        key={editing.id}
                        x={editing.x}
                        y={editing.y}
                        width={editing.width}
                        height={editing.height}
                        angle={editing.angle}
                        zoom={zoom}
                        containerRef={containerRef}
                        boxToStyle={boxToStyle}
                        initialText={editing.text}
                        fontSize={editing.fontSize}
                        fontFamily={editing.fontFamily}
                        textAlign={editing.textAlign}
                        color={editing.strokeColor}
                        onCommit={commitEditing}
                    />
                )}
            </div>
            {/* Remote peers: cursors + selection rings. Screen-space (its own subscription), above
                the scene + local chrome; renders nothing when alone. */}
            <CursorLayer provider={provider} boxes={cursorBoxes} boxToStyle={boxToStyle} />
            {/* OS-file drag-over affordance. Shown only when a drop would actually insert (the drop
                hook stays enabled even when it wouldn't — see above). */}
            <FileDropOverlay visible={isDragging && imagesEnabled} label="Drop images to add" icon={ImageIcon} />
            {/* Finish hint for a multi-point line/arrow draft: the finish triggers aren't discoverable, so
                surface them while collecting clicks. Tokens resolve light inside .eigen-paper. */}
            {drawing.multiPointDraft && (
                <HintPill className="bottom-3 left-1/2 -translate-x-1/2">
                    Enter or double-click to finish · Esc to cancel
                </HintPill>
            )}
            {/* Zoom readout; click resets to 100% about the viewport centre. Bottom-RIGHT: the
                router devtools badge owns the bottom-left corner in dev. */}
            <HintPill className="bottom-3 right-3" title="Reset zoom" onClick={resetZoom}>
                {Math.round(zoom * 100)}%
            </HintPill>
            <VectorObjectMenu
                contextMenu={objectContextMenu}
                onArrange={onMenuArrange}
                onCopy={onMenuCopy}
                onCut={onMenuCut}
                onPaste={onMenuPaste}
                onDuplicate={onMenuDuplicate}
                onDelete={onMenuDelete}
            />
        </div>
    );
}
