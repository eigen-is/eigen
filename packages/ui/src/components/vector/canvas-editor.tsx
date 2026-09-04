import { getBackgroundStyle } from '@workspace/lib/background';
import {
    isPendingMediaName,
    useCopyToMediaFolder,
    useMediaResolver,
    useUploadFile,
    useZombieMediaSweep,
} from '@workspace/lib/drive';
import { stripTagsServer } from '@workspace/lib/html';
import { useIsCoarsePointer } from '@workspace/lib/media';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    arrowRoute,
    type Box,
    computeSnapTargets,
    elementBounds,
    elementsInFrame,
    fitImageSize,
    getElementsBounds,
    IMAGE_CASCADE_OFFSET,
    type ImageSize,
    isLinearElement,
    isTransparentColor,
    type MarqueeMode,
    marqueeMode,
    orderByFractionalIndex,
    parseBackgroundFill,
    parseIdList,
    parsePoints,
    resizeLinear,
    SNAP_SCREEN_THRESHOLD,
    type SnapLine,
    type SnapTargets,
    SVG_NS,
    sceneBounds,
    snapBoxToTargets,
    type VectorArrowElement,
    type VectorElement,
} from '@workspace/lib/vector';
import { CommentIndicator } from '@workspace/ui/components/comments';
import { ObjectTransform } from '@workspace/ui/components/transform/object-transform';
import { cn } from '@workspace/ui/lib/utils';
import { ImageIcon } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTypingTarget } from '../../hooks/is-typing-target';
import { useFileDropTarget } from '../../hooks/use-file-drop-target';
import { useFilePasteTarget } from '../../hooks/use-file-paste-target';
import { CursorLayer } from '../collab';
import { useContextMenu } from '../context-menu';
import { FileDropOverlay } from '../file-drop-overlay';
import { HintPill } from '../hint-pill';
import { readImageSize, readImageSizeFromUrl } from '../media/read-image-size';
import type { ZOp } from '../properties-panel/z-order';
import { CanvasObjectMenu } from './canvas-object-menu';
import { pointerCursor } from './cursor';
import { ElementLayer } from './element-layer';
import { EmptyOutlines } from './empty-outline';
import { randomSeed } from './hooks/element-writes';
import { applyZOrder, deleteSelection, duplicateSelection } from './hooks/selection-ops';
import { useCanvasClipboard } from './hooks/use-canvas-clipboard';
import type { CanvasDoc, NewVectorElement, VectorElementPatch } from './hooks/use-canvas-doc';
import { useCanvasKeyboard } from './hooks/use-canvas-keyboard';
import { type CanvasPeerState, type PublishCursor, peerOnFrame } from './hooks/use-canvas-presence';
import { hitTestTopmost, marqueeSelect } from './hooks/use-selection';
import { useSpaceHeld } from './hooks/use-space-held';
import type { VectorTool } from './hooks/use-tool';
import { useViewport } from './hooks/use-viewport';
import { ELEMENT_KIND_UI } from './kinds';
import { arrowLabelEditing, type EditingState } from './text-editing';
import { isVectorFontLoaded, loadVectorFont, measureVectorText } from './text-measure';
import { TextOverlay } from './text-overlay';
import { buildPreviewById, followArrowPreview, unbindDraggedArrow } from './tools/binding';
import { boundsToBox, boxToBounds, elementBox } from './tools/boxes';
import { type CreatingState, creatingElement, isBoxTool, newShapeBox, normalizeRect } from './tools/create-shape';
import { SnapGuides } from './tools/snap-guides';
import { useTouchGestures } from './tools/touch-gestures';
import { useDrawingTools } from './tools/use-drawing-tools';

// Below this scene-unit extent (in BOTH dimensions) a drag-create is a click → discarded.
const CREATE_MIN_SIZE = 1;
const MIN_ELEMENT_SIZE = 1;
// The box a click with the rich-text tool places, in scene units. It arrives empty and selected.
const NEW_RICHTEXT_SIZE = { width: 200, height: 40 };
// Image drop/paste SIZING (natural-size-that-fits, 80% viewport cap, never upscale, unreadable →
// default box) is the shared `fitImageSize` helper — vector is its reference behavior; the cascade
// offset is the shared IMAGE_CASCADE_OFFSET.
// A bound arrow dragged alone unbinds only past this SCREEN distance, so a click-select never detaches it
// (Excalidraw's DRAGGING_THRESHOLD).
const ARROW_UNBIND_SCREEN = 10;

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
export type CanvasImageInsert = {
    insertFiles: (files: File[]) => void;
    insertDrivePaths: (paths: DrivePath[]) => Promise<void>;
};

type CanvasEditorProps = {
    // The host's document: the scene and every writer, taken whole rather than threaded prop by prop.
    doc: CanvasDoc;
    // 'infinite' is the drawing canvas; 'frame' bounds it to one page — the canvas then renders,
    // hit-tests, snaps and creates inside `frameId` only, and a pan can't push the page off screen.
    viewport: 'infinite' | 'frame';
    // The active frame, '' on the infinite canvas — the home stamped on every new element.
    frameId?: string;
    tool: VectorTool;
    setTool: (t: VectorTool) => void;
    // Tool lock (Q / padlock): a placement keeps the current tool active; threaded like `tool`, toggled here on Q.
    toolLocked: boolean;
    setToolLocked: (locked: boolean) => void;
    canEdit: boolean;
    // Owner + mount of THIS document, for cross-mount image paste (re-upload into our media/ folder).
    ownerId: string;
    mountId: string;
    // Selection is lifted to the editor so the properties panel and canvas share one source (the
    // slides editor/canvas idiom).
    selectedIds: string[];
    setSelectedIds: (ids: string[]) => void;
    toggle: (id: string) => void;
    // Aspect lock, shared with the properties-panel checkbox: ObjectTransform's 'aspect-default'
    // (Shift frees) when on, 'free' when off.
    aspectLocked: boolean;
    // Awareness: doc.provider drives the CursorLayer's own subscription; publishCursor pushes the
    // local pointer's scene position (throttled in the editor's use-canvas-presence).
    publishCursor: PublishCursor;
    // Published/cleared by the canvas itself; optional so read-only hosts can omit it.
    imageInsertRef?: { current: CanvasImageInsert | null };
    // Comments. A commented element marks its top-right corner; clicking the mark opens the first card
    // (the host reveals it). Omitting onOpenCard hides the marks, omitting onAddComment the menu row.
    onOpenCard?: (cardId: string) => void;
    // The document's cards, for the mark's colour — the card's own, like a commented sheet cell's.
    commentCards?: Record<string, CommentCard>;
    onAddComment?: (elementId: string) => void;
    // ⌘F: every matching element rings, the stepped-to one rings brighter and flashes. Both come from
    // the host's useCanvasDocSearch — the canvas only paints them.
    searchMatchedIds?: ReadonlySet<string>;
    searchActiveId?: string | null;
    // Page through frames on a one-finger swipe — the deck shell passes it on a view-only phone.
    onSwipeFrame?: (delta: number) => void;
};

// The live, interactive canvas surface — one absolutely positioned layer per element, with the
// scene-space overlay and the screen-space chrome above it: pan/zoom viewport, tool-driven
// drag-create, selection, move, and the shared ObjectTransform chrome. Every drag/resize/rotate preview is LOCAL state;
// exactly one Yjs transact fires per completed gesture (UX-RULING 5), with stopCapturing() at each
// gesture start so one gesture = one undo step.
export function CanvasEditor({
    doc,
    viewport,
    frameId = '',
    tool,
    setTool,
    toolLocked,
    setToolLocked,
    canEdit,
    ownerId,
    mountId,
    selectedIds,
    setSelectedIds,
    toggle,
    aspectLocked,
    publishCursor,
    imageInsertRef,
    onOpenCard,
    commentCards,
    onAddComment,
    searchMatchedIds,
    searchActiveId,
    onSwipeFrame,
}: CanvasEditorProps) {
    const {
        elements,
        meta,
        frames,
        addElement: addElementRaw,
        addElements: addElementsRaw,
        updateElement,
        updateElementUntracked,
        updateElements,
        deleteElements,
        deleteElementsUntracked,
        duplicateElements,
        undoManager,
        provider,
    } = doc;
    // The page this canvas is bounded to, if any: its extent drives the fit/clamp/snap math and its
    // background paints — and clips — the layers.
    const frame = viewport === 'frame' ? frames.find((f) => f.id === frameId) : undefined;
    // In frame mode the viewport's scene space IS the frame's space (elements store frame-relative
    // coordinates), so an insert needs no translation — only the home frame stamped on it. Every insert
    // path (drag-create, image drop/paste/picker, clipboard) goes through these two, so no callsite can
    // forget it. `frameId` sits AFTER the spread on purpose: a pasted element carries the SOURCE frame's
    // id and must land in the frame being pasted into.
    const addElement = useCallback(
        (partial: NewVectorElement) => addElementRaw({ ...partial, frameId }),
        [addElementRaw, frameId],
    );
    const addElements = useCallback(
        (partials: NewVectorElement[]) => addElementsRaw(partials.map((p) => ({ ...p, frameId }))),
        [addElementsRaw, frameId],
    );
    const {
        containerRef,
        sceneRef,
        overlayRef,
        chromeRef,
        viewportRef,
        clientToScene,
        screenDeltaToScene,
        boxToStyle,
        panBy,
        pinch,
        resetZoom,
        frozenRef,
        zoom,
    } = useViewport({
        mode: viewport,
        frame: frame ? { width: frame.width, height: frame.height } : undefined,
        resetKey: frameId,
    });
    // Coarse pointers (finger/stylus) get a fatter hit-slop and drive the touch gesture policy below.
    const coarse = useIsCoarsePointer();
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
    // Pan mode: space held, or a view-only scene where every primary drag scrolls (one finger on a phone).
    const panMode = spaceHeld || !canEdit;
    const [panning, setPanning] = useState(false);
    // Select-mode hover affordance: true while the idle pointer is over a selectable element, so the
    // cursor signals draggability with `move` (the suite convention — slides/docs). Item E.
    const [hoveringSelectable, setHoveringSelectable] = useState(false);
    const [editing, setEditing] = useState<EditingState | null>(null);
    // In-place rich-text editing. Separate from `editing` (the arrow-label TextOverlay session) because
    // the two never coexist and each owns a different commit contract: a label commits once on close,
    // a rich-text box writes on every change.
    const [richTextEditId, setRichTextEditId] = useState<string | null>(null);
    // The object context menu (right-click) — the singleton surface; item is the right-clicked
    // element id, its ops act on the selection below.
    const objectContextMenu = useContextMenu<string>();

    const gestureRef = useRef<Gesture | null>(null);
    // First onTransform of a resize/rotate is the de-facto gesture start (ObjectTransform fires it
    // synchronously at grip pointerdown); flip it there for the one-stopCapturing-per-gesture rule.
    const transformStartedRef = useRef(false);
    // Latest finishGesture closure, for the window-blur listener bound once below.
    const finishRef = useRef<() => void>(() => {});
    // Latest touch-gesture reset, called from the blur/pointercancel safety net so a torn-down
    // two-finger gesture can't leave stale touch state behind.
    const touchResetRef = useRef<() => void>(() => {});
    // Live editing session, read from event listeners (bound once) that must know a text overlay is
    // open — the freeze safety-net below and commitEditing both consult it.
    const editingRef = useRef<EditingState | null>(null);
    editingRef.current = editing;
    const richTextEditRef = useRef<string | null>(null);
    richTextEditRef.current = richTextEditId;
    // "Some text surface owns the keyboard and the pointer" — every gate that used to read `editing`.
    const textEditing = editing !== null || richTextEditId !== null;
    // The same answer for listeners bound once (the clipboard hook's), which can't read state.
    const textEditingRef = useRef(false);
    textEditingRef.current = textEditing;

    // The elements this canvas renders, hit-tests, marquees, snaps to and selects-all: one frame's in
    // frame mode, the whole scene otherwise. NOT the comment/search paths — both must reach an element
    // on another frame, so both read the host's `elements`.
    const visibleElements = useMemo(
        () => (viewport === 'frame' ? elementsInFrame(elements, frameId) : elements),
        [viewport, elements, frameId],
    );
    const ordered = useMemo(() => orderByFractionalIndex(visibleElements), [visibleElements]);

    // The marked elements: those carrying at least one comment card, with the corner the mark sits on
    // (a zero-size box, so boxToStyle maps it to the screen point at render time) and the card's colour.
    const commentedElements = useMemo(
        () =>
            ordered.flatMap((el) => {
                const [cardId] = parseIdList(el.commentCardIds);
                if (!cardId) return [];
                const box = elementBox(el);
                return [
                    {
                        id: el.id,
                        cardId,
                        color: commentCards?.[cardId]?.color,
                        corner: { x: box.x + box.width, y: box.y, width: 0, height: 0, angle: 0 },
                    },
                ];
            }),
        [ordered, commentCards],
    );

    // The ringed elements. Only what this canvas renders: a match on another frame is revealed by the
    // host activating that frame, and the ring follows.
    const matchedElements = useMemo(
        () => (searchMatchedIds ? ordered.filter((el) => searchMatchedIds.has(el.id)) : []),
        [ordered, searchMatchedIds],
    );

    // All elements by id — the map an elbow arrow reads (arrowRoute) to resolve its bound shapes and
    // derive its route. Deliberately spans the WHOLE scene: an elbow arrow inside a frame still routes
    // around a bound shape outside it. Hit/marquee/label paths use it; the render path overlays previews.
    const committedById = useMemo(() => new Map(elements.map((el) => [el.id, el])), [elements]);

    // Frame mode shows only the peers on this frame; the infinite canvas shows everyone (an undefined
    // filter is CursorLayer's "no filter" contract).
    const isPeerVisible = useMemo(
        () => (viewport === 'frame' ? (s: CanvasPeerState) => peerOnFrame(s, frameId) : undefined),
        [viewport, frameId],
    );

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
        canEdit,
        zoom,
        viewportRef,
        coarse,
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
    const hasArrows = useMemo(() => ordered.some((el) => el.type === 'arrow'), [ordered]);
    const previewById = useMemo(
        () => (hasPreviews && hasArrows ? buildPreviewById(ordered, previews) : null),
        [hasPreviews, hasArrows, ordered, previews],
    );
    // The map the render path feeds an elbow arrow's route: preview boxes when a shape is mid-drag (the
    // snake follows live), else the committed scene — its per-frame identity is the ElementLayer memo's cue.
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

    // Every canvas hotkey (V/R/D/O/T, Q, Delete/Backspace, arrows, ⌘A, ⌘D, ⌘Z/⌘⇧Z, z-order) is gated
    // off while ANY text surface is open — the textarea's native undo/typing owns keys in-session, and
    // the lib's ignoreInputs default does not cover a ProseMirror contenteditable, so a tool letter
    // would otherwise be swallowed as a keystroke inside the in-place editor.
    useCanvasKeyboard({
        enabled: canEdit && !textEditing,
        elements: visibleElements,
        selectedIds,
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
        if (!textEditing) return;
        frozenRef.current = true;
        return () => {
            frozenRef.current = false;
        };
    }, [textEditing, frozenRef]);

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
            if (editingRef.current || richTextEditRef.current) return;
            frozenRef.current = false;
            transformStartedRef.current = false;
            setPreviews((p) => (Object.keys(p).length ? {} : p));
            // Escape-cancelled resizes fire no onCommit, so stale guide lines land here.
            setSnapLines((l) => (l.length ? [] : l));
        };
        const onBlur = () => {
            // The textarea's own onBlur commits a label session; a rich-text session is ended by its
            // own click-away/Escape, and neither may lose the viewport freeze here.
            if (editingRef.current || richTextEditRef.current) return;
            finishRef.current();
            touchResetRef.current();
            clear();
        };
        // pointercancel is a genuine tear-down (lost capture, system gesture) — a plain pointerup is a
        // normal lift the touch handler already unwinds, so only cancel/blur reset the touch state.
        const onCancel = () => {
            touchResetRef.current();
            clear();
        };
        document.addEventListener('pointerup', clear);
        document.addEventListener('pointercancel', onCancel);
        window.addEventListener('blur', onBlur);
        return () => {
            document.removeEventListener('pointerup', clear);
            document.removeEventListener('pointercancel', onCancel);
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

    // Open the overlay on an arrow's label — the one plain-text path left on the canvas. The session
    // shape lives in the pure text-editing module; the canvas only picks the selection and opens.
    const openEditArrowLabel = (el: VectorArrowElement) => {
        const ed = arrowLabelEditing(el, arrowRoute(el, committedById));
        if (!ed) return; // a degenerate arrow (< 2 points) has no label anchor
        setSelectedIds([el.id]);
        setEditing(ed);
    };

    // What this canvas sees (frame-scoped in frame mode) — the snap builder, the resize/move selection
    // paths and the label heal read it. `elementsRef` stays the WHOLE scene: a pending image on another
    // frame is still this tab's to sweep.
    const visibleRef = useRef(visibleElements);
    visibleRef.current = visibleElements;
    const elementsRef = useRef(elements);
    elementsRef.current = elements;

    // Snap targets = every OTHER visible element's edges/centre (rotated → centre only), plus the
    // frame's own edges and centre lines when there is one — an object aligns to the page the way it
    // aligns to its neighbours. The infinite canvas has no edges to seed. Threshold is screen-space:
    // SNAP_SCREEN_THRESHOLD / zoom keeps the snap radius a constant pixel distance at any zoom.
    const buildSnapTargets = useCallback(
        (excludeIds: Set<string>) =>
            computeSnapTargets(
                visibleRef.current.map((el) => ({ id: el.id, box: elementBox(el) })),
                excludeIds,
                frame && [0, frame.width / 2, frame.width],
                frame && [0, frame.height / 2, frame.height],
            ),
        [frame],
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
            const startEl = visibleRef.current.find((el) => el.id === id);
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
                SNAP_SCREEN_THRESHOLD / viewportRef.current.zoom,
            );
            setSnapLines(lines);
            return box;
        },
        [selectedIds, buildSnapTargets, viewportRef],
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

    // The overlay awaits loadVectorFont on open, so commit-time measureVectorText is normally exact.
    // The safety net for the rare commit-before-load-resolves race: if the face isn't loaded, load it
    // and re-measure into the element once it swaps in (self-healing — stored dims are the server
    // renderer's source of truth, and the measurement util stays the sole dim writer). Re-validated
    // against the LIVE element at resolve time: a newer edit (text/font/size) owns the dims, so a
    // slow load can never write stale dims over it — and the single .then can't loop.
    const healLabelWidth = useCallback(
        (id: string, text: string, fontSize: number, fontFamily: string) => {
            if (isVectorFontLoaded(fontSize, fontFamily)) return;
            loadVectorFont(fontSize, fontFamily)
                .then(() => {
                    const el = visibleRef.current.find((x) => x.id === id);
                    if (el?.type !== 'arrow') return; // deleted meanwhile — nothing to heal
                    if (el.text !== text || el.fontSize !== fontSize || el.fontFamily !== fontFamily) return;
                    // A label's height derives from its line count, so only labelWidth is measured.
                    const healed = measureVectorText(text, fontSize, fontFamily);
                    if (healed.width === el.labelWidth) return;
                    undoManager?.stopCapturing();
                    updateElement(id, { labelWidth: healed.width });
                    undoManager?.stopCapturing();
                })
                .catch(() => {});
        },
        [updateElement, undoManager],
    );

    // One editing session → exactly one Yjs write. stopCapturing on both sides so the session is its own
    // undo step. Read the live session from a ref (not a closure) so the callback stays stable and side
    // effects run once, never inside a state updater.
    const commitEditing = useCallback(
        (text: string) => {
            const ed = editingRef.current;
            editingRef.current = null;
            setEditing(null);
            if (!ed) return;
            const empty = text.trim().length === 0;
            // The arrow already exists — write the label in place: `text` + measured `labelWidth`
            // (height derives from the line count) in one sealed transact. An empty label clears both
            // to ''/0 and never deletes the arrow; a still-empty label is a no-op. updateElement no-ops
            // on a Yjs map the arrow's remote deletion already removed.
            if (!(ed.isNew && empty)) {
                const labelWidth = empty ? 0 : measureVectorText(text, ed.fontSize, ed.fontFamily).width;
                undoManager?.stopCapturing();
                updateElement(ed.id, { text: empty ? '' : text, labelWidth });
                undoManager?.stopCapturing();
                if (!empty) healLabelWidth(ed.id, text, ed.fontSize, ed.fontFamily);
            }
            setSelectedIds([ed.id]);
            setTool('select');
        },
        [updateElement, undoManager, setSelectedIds, setTool, healLabelWidth],
    );

    // Open an in-place rich-text session. Seal first, so the session's writes are their own undo step.
    const openRichText = (id: string) => {
        undoManager?.stopCapturing();
        setSelectedIds([id]);
        setRichTextEditId(id);
    };

    // Close it: an empty box is deleted (a rich-text box with no text is invisible chrome), otherwise the
    // trailing seal closes the session's coalesced writes. Reads the LIVE element — the session wrote
    // through updateElement, so React state may be one tick behind.
    const closeRichText = useCallback(() => {
        const id = richTextEditRef.current;
        richTextEditRef.current = null;
        setRichTextEditId(null);
        if (!id) return;
        const el = visibleRef.current.find((e) => e.id === id);
        if (el?.type === 'richtext' && stripTagsServer(el.html).trim() === '') {
            // Seal FIRST: without it, the delete lands inside Y.UndoManager's 500ms captureTimeout and
            // merges into the session's last keystroke, so whether it is its own undo step would depend
            // on how fast the user clicked away.
            undoManager?.stopCapturing();
            deleteElements([id]);
            setSelectedIds([]);
        }
        undoManager?.stopCapturing();
    }, [deleteElements, setSelectedIds, undoManager]);

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
            const { zoom: live } = viewportRef.current;
            const view = { width: (rect?.width ?? 0) / live, height: (rect?.height ?? 0) / live };
            return intrinsics.map((intrinsic, i) => {
                const { width, height } = fitImageSize(intrinsic, view);
                const off = i * IMAGE_CASCADE_OFFSET;
                return { x: anchor.x + off - width / 2, y: anchor.y + off - height / 2, width, height };
            });
        },
        [containerRef, viewportRef],
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
    const imagesEnabled = canEdit && !!mediaFolderId && !textEditing;
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

    // ⌘C/⌘X/⌘V, the menu clipboard rows and the whole paste ladder live in the sibling hook (the
    // canvas only hands it the scene, the selection and the frame-stamped writers).
    const { onMenuCopy, onMenuCut, onMenuPaste } = useCanvasClipboard({
        canEdit,
        textEditingRef,
        viewport,
        frameId,
        ordered,
        meta,
        selectedIds,
        setSelectedIds,
        addElement,
        addElements,
        updateElements,
        updateElementUntracked,
        deleteElements,
        deleteElementsUntracked,
        undoManager,
        viewportCenterScene,
        insertImageFiles,
        mediaFolderId,
        resolveMediaPath,
        resolveMediaUrl,
        uploadFile: uploadFile.mutateAsync,
    });

    // Text-edit entry shared by a mouse double-click and a touch double-tap (touch-gestures synthesizes
    // the tap-tap). frozenRef: no new session over a live gesture. An arrow opens the label overlay;
    // any kind with an in-place editor opens that instead, inside its own layer.
    const openTextAtClient = (clientX: number, clientY: number) => {
        if (!canEdit || tool !== 'select' || textEditing || frozenRef.current) return;
        const p = clientToScene(clientX, clientY);
        const hit = hitTestTopmost(ordered, p, viewportRef.current.zoom, committedById, coarse);
        const hitEl = hit ? ordered.find((el) => el.id === hit) : undefined;
        if (hitEl?.type === 'arrow') openEditArrowLabel(hitEl);
        else if (hitEl && ELEMENT_KIND_UI[hitEl.type].InPlaceEditor) openRichText(hitEl.id);
    };
    const onDoubleClick = (e: React.MouseEvent) => openTextAtClient(e.clientX, e.clientY);

    // Right-click on an element opens the object menu (empty canvas keeps the browser default). Like
    // slides, a right-click on an element outside the current selection selects it first, so the menu
    // ops act on the target; a right-click inside the selection keeps the whole selection. The canvas
    // uses hit-testing (elements have no per-node DOM), so this lives on the container, not per object.
    const onContextMenu = (e: React.MouseEvent) => {
        // frozenRef: no menu over a live left-button gesture (marquee/move keeps its capture).
        if (!canEdit || textEditing || frozenRef.current) return;
        // A multi-point draft runs unfrozen but still owns the pointer: no menu (object or browser)
        // mid-draft — the draft keeps floating and the next left click keeps placing points.
        if (drawing.multiPointDraft) {
            e.preventDefault();
            return;
        }
        const p = clientToScene(e.clientX, e.clientY);
        const hitId = hitTestTopmost(ordered, p, viewportRef.current.zoom, committedById, coarse);
        if (!hitId) return;
        if (!selectedIds.includes(hitId)) setSelectedIds([hitId]);
        objectContextMenu.handleContextMenu(e, hitId);
    };

    // Menu ops act on the full selection, wired to the same writes as ⌘[/] , ⌘D, and Delete so the
    // menu and the keyboard stay one behavior (one sealed undo step each).
    const onMenuArrange = (op: ZOp) => applyZOrder(op, visibleElements, selectedIds, updateElements, undoManager);
    const onMenuDuplicate = () => duplicateSelection(selectedIds, duplicateElements, setSelectedIds, undoManager);
    const onMenuDelete = () => deleteSelection(selectedIds, deleteElements, setSelectedIds, undoManager);
    // A comment is raised on the right-clicked element, not on the selection: a card anchors to one element.
    const menuItemId = objectContextMenu.item;
    // Touch/stylus policy (penMode palm rejection, two-finger pan/pinch, double-tap → text) lives in
    // the sibling module; the canvas only dispatches. Its second-finger takeover ends any live one-finger
    // gesture through this callback (a draw draft in the tools hook, else a canvas create/move/marquee).
    const touch = useTouchGestures({
        tool,
        containerRef,
        frozenRef,
        pinch,
        abortActiveGesture: () => {
            if (!drawing.abortForSecondTouch()) finishRef.current();
        },
        isPenDrawing: drawing.isPenDrawing,
        onDoubleTap: openTextAtClient,
        onSwipe: onSwipeFrame,
    });
    touchResetRef.current = touch.reset;

    const onPointerDown = (e: React.PointerEvent) => {
        // Focus the tabIndex=-1 container so a following paste lands on our onPaste — a bare canvas
        // div never holds focus, so image paste would otherwise bubble past us to the body.
        containerRef.current?.focus();
        // Touch gestures get first dibs (a second finger must intercept even while frozen).
        if (touch.onPointerDown(e)) return;
        // A pointerdown that reaches the CONTAINER is outside the editor (the editor stops its own), so
        // it ends the session; the session's viewport freeze is lifted by its effect on the next render,
        // so this click only closes — the following one selects or draws.
        if (richTextEditRef.current) closeRichText();
        if (frozenRef.current) return; // a gesture is already active (defensive)
        if (panMode || e.button === 1) {
            e.preventDefault();
            containerRef.current?.setPointerCapture(e.pointerId);
            frozenRef.current = true;
            setPanning(true);
            gestureRef.current = { kind: 'pan', pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
            return;
        }
        if (e.button !== 0) return;
        if (!canEdit) return;

        const p = clientToScene(e.clientX, e.clientY);

        // Freehand / line / eraser own their own gesture (local state + capture); the hook consumes
        // the event for those tools and the canvas does nothing more.
        if (drawing.onPointerDown(e, p)) return;

        containerRef.current?.setPointerCapture(e.pointerId);

        // Box tool → start a local (not-yet-Yjs) drag-create. (Freehand/line/eraser already returned via
        // the tools hook.) Rich text drags out like a shape; a click under the threshold places the
        // default box instead of discarding it — see finishGesture.
        if (isBoxTool(tool)) {
            frozenRef.current = true;
            undoManager?.stopCapturing();
            setSelectedIds([]);
            gestureRef.current = { kind: 'create', pointerId: e.pointerId, startX: p.x, startY: p.y };
            setCreating({
                type: tool,
                seed: randomSeed(),
                box: { x: p.x, y: p.y, width: 0, height: 0, angle: 0 },
            });
            return;
        }

        // Select tool.
        const hitId = hitTestTopmost(ordered, p, viewportRef.current.zoom, committedById, coarse);
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
        // Two-finger pan/pinch consumes the move before any single-pointer gesture sees it.
        if (touch.onPointerMove(e)) return;
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
        if (!g && tool === 'select' && !textEditing) {
            const over = hitTestTopmost(ordered, scene, viewportRef.current.zoom, committedById, coarse) !== null;
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
                    SNAP_SCREEN_THRESHOLD / viewportRef.current.zoom,
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
            if (!c) return;
            // A drag under the threshold is a CLICK: a shape is discarded, a rich-text box is placed at
            // its default size, because a click is how you start typing.
            const clicked = c.box.width < CREATE_MIN_SIZE && c.box.height < CREATE_MIN_SIZE;
            if (clicked && c.type !== 'richtext') return;
            const box = clicked ? { ...c.box, ...NEW_RICHTEXT_SIZE } : c.box;
            const id = addElement({
                type: c.type,
                x: box.x,
                y: box.y,
                width: Math.max(MIN_ELEMENT_SIZE, box.width),
                height: Math.max(MIN_ELEMENT_SIZE, box.height),
                seed: c.seed,
            });
            if (id) setSelectedIds([id]);
            // Trailing seal: a nudge inside the 500ms capture window must not merge into
            // this gesture's undo step (nudges deliberately carry no leading stopCapturing).
            undoManager?.stopCapturing();
            // A kind with an in-place editor opens it on creation — an empty box you cannot type into is
            // not a text tool.
            if (id && ELEMENT_KIND_UI[c.type].InPlaceEditor) openRichText(id);
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
                    const farEnough = Math.hypot(dx, dy) * viewportRef.current.zoom >= ARROW_UNBIND_SCREEN;
                    const patches = g.ids
                        .filter((id) => previews[id])
                        .map((id) => {
                            const el = visibleRef.current.find((e) => e.id === id);
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
        // Touch first: ends a pinch, or fires a double-tap (which cleans its own gesture + claims the up).
        if (touch.onPointerUp(e)) return;
        const g = gestureRef.current;
        // A freehand/line/eraser gesture finishes (writes) through the tools hook; a pan (the one canvas
        // gesture that can coexist with a line draft) ends here.
        if (g?.kind !== 'pan' && drawing.onPointerUp(e)) return;
        if (g && e.pointerId !== g.pointerId) return;
        // Read Alt off the terminal event (drop-time modifier) for Alt-drag duplicate.
        finishGesture(e.altKey);
    };

    // The O(elements) scan is memoized; the map over it is O(selection) and reads the live previews.
    const selectedElements = useMemo(() => ordered.filter((el) => selectedIds.includes(el.id)), [ordered, selectedIds]);
    const selectedRender = selectedElements.map(renderEl);
    const single = selectedRender.length === 1 ? selectedRender[0] : null;
    // elementBounds is arrow-aware, so the union ring encloses a labeled arrow's overhang and an
    // elbow arrow's routed bends (arrowRoute, preview-aware via renderById).
    const unionBox = selectedRender.length >= 1 ? boundsToBox(sceneBounds(selectedRender, renderById)) : null;
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
    const showChrome = !creating && !marquee && !textEditing && !drawing.active && !drawing.hiddenId;
    const showTransform = showChrome && canEdit && single !== null && !singleLinear2pt;

    const cursor = pointerCursor({ panning, panMode, tool, hoveringSelectable });
    // The scene's own paint is the INFINITE canvas's background. A frame paints its own (below) and
    // the surface around it stays the app's, so a letterboxed page reads as a page.
    const background = viewport === 'infinite' && !isTransparentColor(meta.background) ? meta.background : undefined;

    // Rich text's height is DERIVED from the text in it, so the layer that renders a box measures it and
    // writes the fit back here — untracked, because a derived size is bookkeeping and not the user's own
    // undo step. Withheld while a gesture is live: a resize preview owns the box it is dragging, and the
    // committed width re-fits it the moment the drag ends.
    const fitElementHeight = useCallback(
        (id: string, height: number) => updateElementUntracked(id, { height }),
        [updateElementUntracked],
    );
    const onFitHeight = canEdit && !hasPreviews && !creating ? fitElementHeight : undefined;

    // One scene node — every render path routes through here so `byId` (an elbow arrow's route context) is
    // threaded in one place, not per callsite.
    const node = (el: VectorElement, children?: ReactNode) => (
        <ElementLayer key={el.id} el={el} resolveMedia={resolveMediaUrl} byId={renderById} onFitHeight={onFitHeight}>
            {children}
        </ElementLayer>
    );

    // Every element's layer, in z-order, plus the in-flight create and freehand/vertex drafts.
    const layers = (
        <>
            {ordered.map((el) => {
                // A line being vertex-dragged is drawn by the drawing preview below instead.
                if (drawing.hiddenId === el.id) return null;
                // Only an arrow label opens the overlay, so the element under edit keeps its
                // shaft/heads and hides just the label the textarea draws (render text='').
                if (editing?.id === el.id && el.type === 'arrow') return node(renderEl({ ...el, text: '' }));
                // The box being edited draws nothing of its own: the in-place editor inside its layer
                // IS the rendering, painted with the same CSS the renderer would have emitted.
                if (el.id === richTextEditId) {
                    const Editor = ELEMENT_KIND_UI[el.type].InPlaceEditor;
                    return Editor
                        ? node(
                              renderEl(el),
                              <Editor
                                  element={el}
                                  onChange={(fields) => updateElement(el.id, fields)}
                                  onExit={closeRichText}
                              />,
                          )
                        : null;
                }
                return node(renderEl(el));
            })}
            {creating && node(creatingElement(creating))}
            {/* Live freehand/line draft, or a point-edit reshape — the SAME render path. */}
            {drawing.previewElement && node(drawing.previewElement)}
        </>
    );

    // A frame is a page: it paints its own background and CLIPS what overhangs it. The infinite canvas
    // has no such box — its layers sit straight on the scene.
    const frameLayers = frame ? (
        <div
            className="absolute overflow-hidden"
            style={{
                left: 0,
                top: 0,
                width: frame.width,
                height: frame.height,
                ...getBackgroundStyle(parseBackgroundFill(frame.background), resolveMediaUrl),
            }}
        >
            {layers}
        </div>
    ) : (
        layers
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
            {/* The scene: plain SCENE units, one layer div per element. pointer-events-none — hit
                testing is geometry math on the container, never DOM hit testing. The viewport writes
                the transform of this node (and of the two below) itself, so a pan/zoom event moves
                them without a React render. */}
            <div ref={sceneRef} className="pointer-events-none absolute inset-0 origin-top-left">
                {frameLayers}
            </div>
            {/* Scene-space chrome stays SVG: guides and bind affordances ride rotation/zoom for free. */}
            <svg className="pointer-events-none absolute inset-0 h-full w-full" xmlns={SVG_NS}>
                <g ref={overlayRef}>
                    <SnapGuides lines={snapLines} />
                    {drawing.bindingOutline}
                    {drawing.snapDots}
                    {drawing.focusIndicators}
                </g>
            </svg>
            {/* Screen-space chrome, laid out by boxToStyle at the viewport React last rendered; a live
                gesture moves the whole layer with one transform (chromeTransform) instead. */}
            <div ref={chromeRef} className="pointer-events-none absolute inset-0 origin-top-left">
                {/* Invisible-but-real elements, ringed while editing so they stay findable. */}
                {canEdit && <EmptyOutlines elements={ordered} boxToStyle={boxToStyle} />}
                {/* ⌘F match rings, in the same screen-space chrome layer as the selection ring. */}
                {matchedElements.map((el) => (
                    <div
                        key={el.id}
                        className={cn(
                            'pointer-events-none absolute',
                            el.id === searchActiveId
                                ? 'eigen-search-ring-active eigen-search-flash'
                                : 'eigen-search-ring',
                        )}
                        style={{
                            ...boxToStyle(elementBox(el)),
                            transform: el.angle ? `rotate(${el.angle}deg)` : undefined,
                        }}
                    />
                ))}
                {showTransform && single && (
                    <ObjectTransform
                        box={elementBox(single)}
                        boxToStyle={boxToStyle}
                        screenDeltaToScene={screenDeltaToScene}
                        showRotate
                        // The shared aspect lock: 'aspect-default' (Shift frees) when checked, else 'free'.
                        resizeMode={aspectLocked ? 'aspect-default' : 'free'}
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
                            if (isLinearElement(single)) {
                                // A linear element rescales its points to the new box through resizeLinear,
                                // reading the COMMITTED element so the total scale is exact.
                                if (next.width !== start.width || next.height !== start.height) {
                                    const base = visibleRef.current.find((b) => b.id === single.id);
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
                {/* Comment marks: LAST in the chrome layer, so the transform box's own NE grip — which
                    sits on the very corner a mark claims — can never cover one. Screen-space like the
                    selection ring, so they keep their size at any zoom. */}
                {onOpenCard &&
                    commentedElements.map(({ id, cardId, color, corner }) => {
                        const { left, top } = boxToStyle(corner);
                        return (
                            <button
                                key={id}
                                type="button"
                                // -translate-x-full hangs the triangle inside the box, off the exact corner.
                                className="pointer-events-auto absolute -translate-x-full"
                                style={{ left, top }}
                                // The container captures the pointer on its own pointerdown, so the click
                                // that would follow never lands on us (it retargets): open from the pointer
                                // event itself, and keep it off the canvas so it starts no drag.
                                onPointerDown={(e) => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    onOpenCard(cardId);
                                }}
                                title="Open comment"
                            >
                                <CommentIndicator color={color} className="block" />
                            </button>
                        );
                    })}
                {/* Round vertex handles: over the box for a 3+-point linear, the sole chrome for a 2-point one. */}
                {drawing.handles}
                {/* Dashed union ring for multi-select + read-only single selections; a writable 2-point line/arrow shows only its handles. */}
                {showChrome && !showTransform && unionBox && !(singleLinear2pt && canEdit) && (
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
                {/* Remote peers: cursors + selection rings. Screen-space (its own subscription), above
                    the local chrome; renders nothing when alone. */}
                <CursorLayer
                    provider={provider}
                    boxes={cursorBoxes}
                    boxToStyle={boxToStyle}
                    isPeerVisible={isPeerVisible}
                />
            </div>
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
            <CanvasObjectMenu
                contextMenu={objectContextMenu}
                onArrange={onMenuArrange}
                onCopy={onMenuCopy}
                onCut={onMenuCut}
                onPaste={onMenuPaste}
                onDuplicate={onMenuDuplicate}
                onDelete={onMenuDelete}
                onComment={onAddComment && menuItemId ? () => onAddComment(menuItemId) : undefined}
            />
        </div>
    );
}
