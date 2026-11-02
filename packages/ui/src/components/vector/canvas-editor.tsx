// CanvasEditor, the live canvas a host mounts, such as Vector's infinite drawing or one Slides page. It draws a layer
// per element and runs every gesture on them: pan and zoom, drag-create, select, move, the transform grips, text
// editing, paste and drop, and the keyboard. A gesture previews in local state and writes one Yjs transaction when it
// ends, so one gesture is one undo step.

import {
    isPendingMediaName,
    useCopyToMediaFolder,
    useMediaResolver,
    useUploadFile,
    useZombieMediaSweep,
} from '@workspace/lib/drive';
import { useIsCoarsePointer } from '@workspace/lib/media';
import type { ChartType } from '@workspace/lib/types/chart';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import type {
    Box,
    ImageSize,
    MarqueeMode,
    NewVectorElement,
    Point,
    SnapLine,
    SnapTargets,
    StyleDefaults,
    VectorArrowElement,
    VectorElement,
    VectorElementPatch,
    ZOp,
} from '@workspace/lib/vector';
import {
    arrowRoute,
    boxCenter,
    canvasImageName,
    computeSnapTargets,
    elementBounds,
    elementsInFrame,
    FRAME_CARD_BORDER,
    FRAME_CARD_RADIUS,
    fitImageSize,
    getElementsBounds,
    IMAGE_CASCADE_OFFSET,
    isLinearElement,
    isTextBox,
    isTextual,
    isTransparentColor,
    marqueeMode,
    NEW_TEXT_BOX_SIZE,
    orderByFractionalIndex,
    paintsNothing,
    parseIdList,
    parsePoints,
    pointInFrame,
    randomSeed,
    resizeLinear,
    rotatePoint,
    SNAP_SCREEN_THRESHOLD,
    SVG_NS,
    sceneBounds,
    snapBoxToTargets,
} from '@workspace/lib/vector';
import { CommentIndicator } from '@workspace/ui/components/comments';
import { sealed } from '@workspace/ui/components/properties-panel';
import { cn } from '@workspace/ui/lib/utils';
import { ImageIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTypingTarget } from '../../hooks/is-typing-target';
import { useDialogOpen, useMenuOpen } from '../../hooks/use-dialog-open';
import { useFileDropTarget } from '../../hooks/use-file-drop-target';
import { useFilePasteTarget } from '../../hooks/use-file-paste-target';
import { CursorLayer } from '../collab';
import type { MenuSectionsProps } from '../context-menu';
import {
    ClipboardMenuItems,
    ContextMenuAnchor,
    MenuSections,
    ObjectContextMenu,
    useContextMenu,
} from '../context-menu';
import { FileDropOverlay } from '../file-drop-overlay';
import { HintPill } from '../hint-pill';
import { readImageSize, readImageSizeFromUrl } from '../media/read-image-size';
import { pressClosesMenu } from '../menubar';
import { ObjectTransform } from '../transform/object-transform';
import { pointerCursor } from './cursor';
import { ElementLayer } from './element-layer';
import { EmptyOutlines } from './empty-outline';
import {
    applyZOrder,
    convertElementToShapes,
    deleteSelection,
    duplicateSelection,
    selectionShapes,
} from './hooks/selection-ops';
import { dropOutsideTextSelection, useCanvasClipboard } from './hooks/use-canvas-clipboard';
import type { CanvasDoc } from './hooks/use-canvas-doc';
import { useCanvasKeyboard } from './hooks/use-canvas-keyboard';
import type { CanvasPeerState, PublishCursor } from './hooks/use-canvas-presence';
import { peerOnFrame } from './hooks/use-canvas-presence';
import { hitTestTopmost, marqueeSelect } from './hooks/use-selection';
import { useSpaceHeld } from './hooks/use-space-held';
import type { VectorTool } from './hooks/use-tool';
import { useViewport } from './hooks/use-viewport';
import { ELEMENT_KIND_UI } from './kinds';
import { newChartElement } from './kinds/chart';
import { RichTextInPlaceEditor } from './kinds/rich-text';
import { CANVAS_PAPER_CLASS, canvasSurfaceClass, FramePage } from './paper';
import type { EditingState } from './text-editing';
import { arrowLabelEditing } from './text-editing';
import { useArrowLabelFit } from './text-fit';
import { TextOverlay } from './text-overlay';
import { buildPreviewById, followArrowPreview, unbindDraggedArrow } from './tools/binding';
import { boundsToBox, boxToBounds, elementBox } from './tools/boxes';
import type { CreatingState } from './tools/create-shape';
import { boxToolElement, creatingElement, isBoxTool, newShapeBox, normalizeRect } from './tools/create-shape';
import { SnapGuides } from './tools/snap-guides';
import { useTouchGestures } from './tools/touch-gestures';
import { useDrawingTools } from './tools/use-drawing-tools';

// A drag-create smaller than this in both directions, in scene units, is a click.
const CREATE_MIN_SIZE = 1;
const MIN_ELEMENT_SIZE = 1;
// A bound arrow dragged alone lets go of its shape only past this distance in screen px, so a click that selects it
// never detaches it. It is Excalidraw's DRAGGING_THRESHOLD.
const ARROW_UNBIND_SCREEN = 10;

// `pointerId` ties a gesture to the pointer that started it. On touch, a second finger's events would otherwise drive
// the first finger's gesture and commit it early.
type Gesture = { pointerId: number } & (
    | { kind: 'pan'; lastX: number; lastY: number }
    | {
          kind: 'move';
          startX: number;
          startY: number;
          originals: Record<string, { x: number; y: number }>;
          ids: string[];
          moved: boolean;
          // The selected elements, taken once, because committed geometry holds still during the gesture and only
          // previews move. The move tick reads them instead of scanning the scene every frame.
          selById: Map<string, VectorElement>;
          // The edges and centers of every other element, which hold still during the gesture too, so the snap targets
          // are computed once here.
          snapTargets: SnapTargets;
      }
    | { kind: 'create'; startX: number; startY: number }
    | { kind: 'marquee'; startX: number; startY: number; additive: boolean; base: string[] }
);

// The imperative surface the canvas publishes for its host: the toolbar's Insert entries, which need the live viewport
// to place, and a reveal, such as for ⌘F or a comment card, which pans the element to the center at the current zoom.
export type CanvasHandle = {
    insertFiles: (files: File[]) => void;
    insertDrivePaths: (paths: DrivePath[]) => Promise<void>;
    insertChart: (type: ChartType) => void;
    centerOn: (el: VectorElement) => void;
    // Every element the canvas shows, on its background, as the SVG the browser draws, such as for File › Download.
    downloadDrawing: () => void;
};

type CanvasEditorProps = {
    // The host's document: the scene and every writer, taken whole rather than threaded prop by prop.
    doc: CanvasDoc;
    // 'infinite' is the drawing canvas. 'frame' bounds it to one page: the canvas then renders, hit-tests, snaps and
    // creates inside `frameId` only, and a pan can't push the page off screen.
    viewport: 'infinite' | 'frame';
    // The active frame, or '' on the infinite canvas: the home stamped on every new element.
    frameId?: string;
    // The host's style table (the same one its useCanvasDoc writes through), so a drag-create preview
    // looks exactly like the element that lands.
    styleDefaults: StyleDefaults;
    tool: VectorTool;
    setTool: (t: VectorTool) => void;
    // The tool lock, Q or the padlock, keeps the tool after a placement. It is passed in like `tool`; Q toggles it.
    toolLocked: boolean;
    setToolLocked: (locked: boolean) => void;
    canEdit: boolean;
    // This document's owner and mount, for an image pasted from another mount, which uploads into our media folder.
    ownerId: string;
    mountId: string;
    // The document's file name, which a downloaded image is named for, less its extension.
    fileName: string;
    // The selection lives in the editor, so the properties panel and the canvas share one source.
    selectedIds: string[];
    setSelectedIds: (ids: string[]) => void;
    toggle: (id: string) => void;
    // The aspect lock, shared with the panel's checkbox. While it is on, a resize keeps the aspect and Shift frees it.
    aspectLocked: boolean;
    // Awareness: doc.provider drives the CursorLayer's own subscription, and publishCursor sends the local pointer's
    // scene position, throttled downstream.
    publishCursor: PublishCursor;
    // The canvas publishes and clears it itself. It is optional, so a read-only host can leave it out.
    canvasRef?: { current: CanvasHandle | null };
    // Comments. A commented element shows a mark at its top-right corner, and a click on the mark opens its first card,
    // which the host reveals. Without onOpenCard there are no marks, and without onAddComment no menu row.
    onOpenCard?: (cardId: string) => void;
    // The document's cards, for the mark's color, which is the card's own, as on a commented sheet cell.
    commentCards?: Record<string, CommentCard>;
    onAddComment?: (elementId: string) => void;
    // ⌘F: every match rings, and the one stepped to rings brighter and flashes. Both come from the host's
    // useCanvasDocSearch, and the canvas only paints them.
    searchMatchedIds?: ReadonlySet<string>;
    searchActiveId?: string | null;
    // Pages through frames on a one-finger swipe, such as in a deck viewed on a phone.
    onSwipeFrame?: (delta: number) => void;
    // Opens the host's image picker on the image key. The toolbar gets the same callback.
    onInsertImage?: () => void;
    // The host's rows on a right-click on empty canvas, below the canvas's own Paste, such as a deck's slide rows.
    backgroundMenu?: Omit<MenuSectionsProps, 'clipboard'>;
};

// The live canvas surface: one absolutely positioned layer per element, with the scene-space overlay and the
// screen-space chrome above it. Every drag, resize and rotate previews in local state. A gesture writes one Yjs
// transaction when it ends, and a seal at its start makes that one undo step.
export function CanvasEditor({
    doc,
    viewport,
    frameId = '',
    styleDefaults,
    tool,
    setTool,
    toolLocked,
    setToolLocked,
    canEdit,
    ownerId,
    mountId,
    fileName,
    selectedIds,
    setSelectedIds,
    toggle,
    aspectLocked,
    publishCursor,
    canvasRef,
    onOpenCard,
    commentCards,
    onAddComment,
    searchMatchedIds,
    searchActiveId,
    onSwipeFrame,
    onInsertImage,
    backgroundMenu,
}: CanvasEditorProps) {
    const imageName = stripEigenExtension(fileName);
    const {
        elements,
        meta,
        frames,
        addElement: addElementRaw,
        addElements: addElementsRaw,
        updateElement,
        updateElementUntracked,
        updateElements,
        updateElementsUntracked,
        deleteElements,
        deleteElementsUntracked,
        duplicateElements,
        replaceElement,
        reorderElements,
        undoManager,
        provider,
    } = doc;
    // The page this canvas is bounded to, if any. Its size drives the fit, the clamp and the snap, and its background
    // paints and clips the layers.
    const frame = viewport === 'frame' ? frames.find((f) => f.id === frameId) : undefined;
    // In frame mode the viewport's scene space is the frame's own, because elements store coordinates relative to it.
    // So an insert needs no translation, only the home frame stamped on it. Every insert goes through these two, such
    // as a drag-create, an image drop or a paste, so none can forget it. `frameId` comes after the spread on purpose: a
    // pasted element carries the frame it was copied from and must land in the frame it is pasted into.
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
        centerOn,
        frozenRef,
        zoom,
    } = useViewport({
        mode: viewport,
        frame: frame ? { width: frame.width, height: frame.height } : undefined,
        resetKey: frameId,
    });
    // A coarse pointer, a finger or a stylus, gets a larger hit slop and drives the touch policy below.
    const coarse = useIsCoarsePointer();
    // Images resolve and upload through the container's media folder, from the provider the editor wraps around the
    // canvas. resolveMediaUrl feeds every image's href, startUpload drives the optimistic insert, and resolveMediaPath
    // gives a copied image a source path another mount can fetch.
    const { resolveMediaUrl, resolveMediaUrlByPath, resolveMediaPath, startUpload, mediaFolderId } = useMediaResolver();
    // A paste from another mount uploads a copied image's bytes into our media folder. mutateAsync is stable.
    const uploadFile = useUploadFile(ownerId, mountId);
    // The toolbar's Add image copies a Drive pick into the media folder first. mutateAsync is stable.
    const { mutateAsync: copyToMediaFolder } = useCopyToMediaFolder(ownerId, mountId);

    const [previews, setPreviews] = useState<Record<string, Box>>({});
    const [creating, setCreating] = useState<CreatingState | null>(null);
    // The marquee carries its mode so the render can show it: solid when it selects what it contains, dashed when it
    // selects what it touches.
    const [marquee, setMarquee] = useState<{ box: Box; mode: MarqueeMode } | null>(null);
    // The snap guide lines, in scene coordinates, while a move or resize snaps. They clear when the gesture ends.
    const [snapLines, setSnapLines] = useState<SnapLine[]>([]);
    const spaceHeld = useSpaceHeld();
    // Pan mode: space held, or a view-only scene, where every primary drag scrolls, such as one finger on a phone.
    const panMode = spaceHeld || !canEdit;
    const [panning, setPanning] = useState(false);
    // True while the idle pointer is over an element it can select, so the cursor shows `move` there, as in the other
    // apps.
    const [hoveringSelectable, setHoveringSelectable] = useState(false);
    const [editing, setEditing] = useState<EditingState | null>(null);
    // In-place rich-text editing. Separate from `editing` (the arrow-label TextOverlay session) because
    // the two never coexist and each owns a different commit contract: a label commits once on close,
    // an element's rich text writes on every change.
    const [richTextEditId, setRichTextEditId] = useState<string | null>(null);
    // The element whose kind's EditDialog a double-click opened (a chart's Edit data).
    const [editDialogId, setEditDialogId] = useState<string | null>(null);
    // The object context menu. Its item is the right-clicked element's id, and its rows act on the selection.
    const objectContextMenu = useContextMenu<string>();
    const backgroundContextMenu = useContextMenu<true>();

    const gestureRef = useRef<Gesture | null>(null);
    // The first onTransform of a resize or rotate is the gesture's start, because ObjectTransform fires it at the
    // grip's pointerdown. The seal happens there, once per gesture.
    const transformStartedRef = useRef(false);
    // The latest finishGesture, for the window blur listener that is bound once below.
    const finishRef = useRef<() => void>(() => {});
    // The latest touch reset, called from the blur and pointercancel safety net, so a two-finger gesture torn down half
    // way leaves no stale touch state.
    const touchResetRef = useRef<() => void>(() => {});
    // The live label session, for the listeners bound once that must know a label editor is open, such as the freeze
    // safety net below and commitEditing.
    const editingRef = useRef<EditingState | null>(null);
    editingRef.current = editing;
    const richTextEditRef = useRef<string | null>(null);
    richTextEditRef.current = richTextEditId;
    // Whether a text editor owns the keyboard and the pointer.
    const textEditing = editing !== null || richTextEditId !== null;
    // The same answer for the listeners bound once, such as the clipboard hook's, which can't read state.
    const textEditingRef = useRef(false);
    textEditingRef.current = textEditing;

    // The elements this canvas renders, hit-tests, marquees, snaps to and selects: one frame's in frame mode, the whole
    // scene otherwise. Comments and search read the host's `elements` instead, because both must reach an element on
    // another frame.
    const visibleElements = useMemo(
        () => (viewport === 'frame' ? elementsInFrame(elements, frameId) : elements),
        [viewport, elements, frameId],
    );
    const ordered = useMemo(() => orderByFractionalIndex(visibleElements), [visibleElements]);

    // The marked elements: those carrying at least one comment card, with the corner the mark sits on
    // (a zero-size box, so boxToStyle maps it to the screen point at render time) and the card's color.
    // A card id with no card is skipped: `comments` is not a declared yjsRoot, so restoring a version
    // from before a delete brings the element's id back without its card.
    const commentedElements = useMemo(
        () =>
            ordered.flatMap((el) => {
                const cardId = parseIdList(el.commentCardIds).find((id) => commentCards?.[id]);
                if (!cardId) return [];
                const box = elementBox(el);
                // The corner travels with the element's rotation, like every other chrome layer, so the
                // mark stays on a rotated shape instead of floating beside it.
                const { x, y } = rotatePoint({ x: box.x + box.width, y: box.y }, boxCenter(box), box.angle);
                return [
                    {
                        id: el.id,
                        cardId,
                        color: commentCards?.[cardId]?.color,
                        corner: { x, y, width: 0, height: 0, angle: 0 },
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

    // Every element by id, the map arrowRoute reads to resolve an elbow arrow's bound shapes. It spans the whole scene
    // on purpose: an elbow arrow inside a frame still routes around a bound shape outside it. The hit test, the marquee
    // and the label read it, and the render path lays the previews over it.
    const committedById = useMemo(() => new Map(elements.map((el) => [el.id, el])), [elements]);

    // Frame mode shows only the peers on this frame, and the infinite canvas shows everyone, which CursorLayer reads
    // from an undefined filter.
    const isPeerVisible = useMemo(
        () => (viewport === 'frame' ? (s: CanvasPeerState) => peerOnFrame(s, frameId) : undefined),
        [viewport, frameId],
    );

    // Element boxes by id for the remote selection rings. They are built again only when the scene changes, never on a
    // peer's cursor move, because the layer holds its own awareness subscription.
    const cursorBoxes = useMemo(() => {
        const m = new Map<string, Box>();
        // An elbow arrow's ring encloses its routed polyline, the derived route or the pinned one, never the frame of
        // its two endpoints. Every other element keeps its own turned box.
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

    // The freehand, line and eraser gestures and a line's point handles live in a sibling hook, so this file only
    // dispatches to them and does not grow. `busy` hides the point handles while any canvas gesture or overlay owns
    // the surface.
    const drawing = useDrawingTools({
        tool,
        setTool,
        toolLocked,
        canEdit,
        zoom,
        viewportRef,
        coarse,
        styleDefaults,
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

    // The elements with their live preview boxes: the map a bound arrow follows while its shape is dragged. It is built
    // only while a preview is live and the scene holds an arrow, so a drag without arrows allocates nothing each frame.
    const hasPreviews = Object.keys(previews).length > 0;
    const hasArrows = useMemo(() => ordered.some((el) => el.type === 'arrow'), [ordered]);
    const previewById = useMemo(
        () => (hasPreviews && hasArrows ? buildPreviewById(ordered, previews) : null),
        [hasPreviews, hasArrows, ordered, previews],
    );
    // The map the render path feeds an elbow arrow's route: the previews while a shape is dragged, so the route follows
    // live, and the committed scene otherwise. Its identity each frame is the ElementLayer memo's cue.
    const renderById = previewById ?? committedById;

    // An element renders with its live preview over its stored values. Without a preview it keeps its identity, so the
    // memo skips it. A linear element's resize scales its points each frame through resizeLinear, a bound arrow follows
    // a shape being dragged, and an element about to be erased dims to 20%.
    const renderEl = (el: VectorElement): VectorElement => {
        const p = previews[el.id];
        let out = el;
        if (p) {
            // Only a size change rescales the points each frame. A move or a turn applies position and angle straight
            // through, where resizeLinear would derive the same box and points.
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

    // Every canvas hotkey stands down while a text editor is open. The textarea's own undo and typing own the keys
    // then, and the keyboard library's ignoreInputs does not cover a ProseMirror contenteditable, so a tool letter
    // would be lost inside the in-place editor. An open dialog stands the keymap down too, or Delete on its button
    // would delete the selection behind it. So does an open menu, whose arrow keys would nudge the selection, except
    // for undo and redo.
    const dialogOpen = useDialogOpen();
    const menuOpen = useMenuOpen();
    useCanvasKeyboard({
        enabled: canEdit && !textEditing && !dialogOpen,
        menuOpen,
        elements: visibleElements,
        selectedIds,
        setTool,
        toolLocked,
        setToolLocked,
        setSelection: setSelectedIds,
        undoManager,
        deleteElements,
        updateElements,
        reorderElements,
        duplicateElements,
        onInsertImage,
        containerRef,
        onEdit: (el) => editElement(el),
    });

    // The viewport freezes while a text editor is open, through the gestures' latch, because a pan or zoom would move
    // the page away from the editor over it.
    useEffect(() => {
        if (!textEditing) return;
        frozenRef.current = true;
        return () => {
            frozenRef.current = false;
        };
    }, [textEditing, frozenRef]);

    // A safety net: any pointerup ends the freeze, clears the transform-start latch and drops leftover previews.
    // ObjectTransform's Escape and a press that never moved fire no onCommit, so their preview would stick and hide
    // later remote edits of that element. It is registered at mount, so on a normal commit it runs before
    // ObjectTransform's own pointerup listener, and the onCommit write replaces the clear in the same render. A window
    // blur can swallow the pointerup, such as an alt-tab mid-drag, so it finishes any live canvas gesture first, as
    // ObjectTransform commits on blur.
    useEffect(() => {
        const clear = () => {
            // An open text session owns the freeze until it ends. The opening click's own pointerup and every caret
            // click inside the editor must not lift it, or a wheel zoom, a second session or a stray move would start
            // mid-edit. The effect above lifts the freeze when the session ends.
            if (editingRef.current || richTextEditRef.current) return;
            frozenRef.current = false;
            transformStartedRef.current = false;
            setPreviews((p) => (Object.keys(p).length ? {} : p));
            // A resize canceled with Escape fires no onCommit, so its guide lines are cleared here.
            setSnapLines((l) => (l.length ? [] : l));
        };
        const onBlur = () => {
            // The textarea's own onBlur commits a label session, and a rich-text session ends on its own click-away or
            // Escape. Neither may lose the freeze here.
            if (editingRef.current || richTextEditRef.current) return;
            finishRef.current();
            touchResetRef.current();
            clear();
        };
        // A pointercancel is a real tear-down, such as lost capture or a system gesture. A plain pointerup is a normal
        // lift the touch handler unwinds itself, so only a cancel and a blur reset the touch state.
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

    // The canvas's Escape, in the bubble phase. ObjectTransform claims Escape during a resize or rotate in the capture
    // phase, so this never fires during a grip drag. It cancels the canvas's own gesture, or else deselects, or else
    // returns to the select tool.
    const escRef = useRef({ hasSelection: false, tool, toolLocked, dialogOpen });
    escRef.current = { hasSelection: selectedIds.length > 0, tool, toolLocked, dialogOpen };
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            // A dialog, a menu or a palette input owns its own Escape (close, clear). No gesture can be
            // active while one is up, so skipping the whole handler is safe. A menu closes in the capture
            // phase and is gone before this runs, but Radix marks the Escape it handled as prevented.
            if (e.key !== 'Escape' || e.defaultPrevented || isTypingTarget() || escRef.current.dialogOpen) return;
            const g = gestureRef.current;
            const s = escRef.current;
            if (g) {
                gestureRef.current = null;
                frozenRef.current = false;
                if (g.kind === 'create') {
                    setCreating(null);
                    // The padlock survives a canceled placement as it survives a completed one.
                    if (!s.toolLocked) setTool('select');
                } else if (g.kind === 'marquee') {
                    setMarquee(null);
                    // A cancel restores the gesture's base: the earlier selection for an additive marquee, and nothing
                    // for a plain one. A press on empty canvas deselects at once, so staying deselected on Escape
                    // matches Excalidraw.
                    setSelectedIds(g.base);
                } else if (g.kind === 'move') {
                    setPreviews({});
                    setSnapLines([]);
                } else {
                    setPanning(false);
                }
                return;
            }
            if (s.hasSelection) setSelectedIds([]);
            else if (s.tool !== 'select') setTool('select');
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [frozenRef, setTool, setSelectedIds]);

    // Opens the label editor on an arrow's label, the one plain-text editor on the canvas. arrowLabelEditing shapes the
    // session, and the canvas only selects and opens.
    const openEditArrowLabel = (el: VectorArrowElement) => {
        const ed = arrowLabelEditing(el, arrowRoute(el, committedById));
        if (!ed) return false; // an arrow of fewer than two points has no place for a label
        setSelectedIds([el.id]);
        setEditing(ed);
        return true;
    };

    // What this canvas shows, one frame's elements in frame mode. The snap targets and the resize and move paths read
    // it. `elementsRef` stays the whole scene, because a pending image on another frame is still this tab's to sweep.
    const visibleRef = useRef(visibleElements);
    visibleRef.current = visibleElements;
    const elementsRef = useRef(elements);
    elementsRef.current = elements;

    // Snap targets: the edges and centers of every other visible element, only the center of a turned one, plus the
    // frame's edges and center lines when there is one, so an object aligns to the page as it aligns to its neighbors.
    // The infinite canvas has no edges. The threshold is in screen px: SNAP_SCREEN_THRESHOLD / zoom keeps the radius
    // the same at any zoom.
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

    // Snapping during a resize, through ObjectTransform's snapBox. A move snaps in the gesture loop below. It finds the
    // moved edge by comparing the box with the element's committed box, which holds still during a local resize. A
    // turned box doesn't snap, because its axis-aligned edges are not the ones the user sees. The matched guide lines
    // go to the overlay.
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

    // Sweeps the image placeholders a tab left behind when it closed or reloaded mid-upload. This canvas mounts only
    // after the doc syncs, so the mount is the ready signal, and this tab's own uploads start later, never in the
    // mount's snapshot. The sweep takes the pending ids, checks each again at removal, because another tab may have
    // finished its upload meanwhile, and deletes the rest in one untracked write, because a sweep must never be
    // undoable.
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

    // One label session is one Yjs write, sealed so it is its own undo step. It reads the live session from a ref, not
    // a closure, so the callback stays stable and its side effects run once, never inside a state updater.
    const commitEditing = useCallback(
        (text: string) => {
            const ed = editingRef.current;
            editingRef.current = null;
            setEditing(null);
            if (!ed) return;
            const empty = text.trim().length === 0;
            // The arrow already exists, so the label's text is written in place, and useArrowLabelFit measures its
            // width. An emptied label clears the text and never deletes the arrow, and a new label left empty writes
            // nothing. updateElement writes nothing when a peer deleted the arrow meanwhile.
            if (!(ed.isNew && empty)) sealed(undoManager, () => updateElement(ed.id, { text: empty ? '' : text }));
            setSelectedIds([ed.id]);
            setTool('select');
        },
        [updateElement, undoManager, setSelectedIds, setTool],
    );

    // Open an in-place rich-text session. Seal first, so the session's writes are their own undo step.
    const openRichText = (id: string) => {
        undoManager?.stopCapturing();
        setSelectedIds([id]);
        setRichTextEditId(id);
    };

    // Close it. An empty text box that paints nothing is deleted. A shape stays, because the user drew it. Otherwise the
    // trailing seal closes the session's writes. It reads the live element: the session wrote through updateElement, so
    // React state may be one tick behind.
    const closeRichText = useCallback(() => {
        const id = richTextEditRef.current;
        richTextEditRef.current = null;
        setRichTextEditId(null);
        if (!id) return;
        const el = visibleRef.current.find((e) => e.id === id);
        if (el && isTextBox(el) && paintsNothing(el)) {
            // Sealed on both sides. Without the leading seal the delete would land inside the undo manager's 500 ms
            // window and merge into the session's last keystroke, so whether it is its own undo step would depend on
            // how fast the user clicked away.
            sealed(undoManager, () => deleteElements([id]));
            setSelectedIds([]);
            return;
        }
        // The trailing seal makes the session's writes one undo step.
        undoManager?.stopCapturing();
    }, [deleteElements, setSelectedIds, undoManager]);

    // A paste carries no coordinates (unlike a drop), so it anchors on the visible viewport center.
    const viewportCenterScene = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return { x: 0, y: 0 };
        return clientToScene(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }, [clientToScene, containerRef]);

    // Boxes at natural size for a batch of images, each fitted into the visible viewport without upscaling, centered on
    // `anchor`, and each next one offset by the cascade. Every image insert shares it.
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

    // Dropped or pasted images upload into the media folder and land at natural size, centered on `anchor`, cascading
    // when there are several. Their sizes are read first, so the adds run as one synchronous batch and one undo step:
    // an await between adds could split it past the undo window. Each element draws at once from its pending blob URL.
    // The swap to the real media name is a late write of its own, and useUploadFile shows the failure toast.
    const insertImageFiles = useCallback(
        async (files: File[], anchor: { x: number; y: number }) => {
            if (!mediaFolderId) return; // no folder to upload into
            const images = files.filter((f) => f.type.startsWith('image/'));
            if (!images.length) return;
            const measured = await Promise.all(
                // readImageSize gives null for a file with no size of its own, such as an SVG, and fitImageSize gives
                // that the default box, so the file is placed, not dropped.
                images.map(async (file) => ({ file, intrinsic: await readImageSize(file) })),
            );

            const boxes = imagePlacements(
                measured.map((m) => m.intrinsic),
                anchor,
            );

            // The whole batch is one undo step.
            const pending: { id: string; promise: Promise<DrivePath | null> }[] = [];
            sealed(undoManager, () => {
                for (const [i, { file }] of measured.entries()) {
                    const { pendingName, promise } = startUpload(file);
                    const id = addElement({ type: 'image', ...boxes[i], mediaName: pendingName });
                    if (id) pending.push({ id, promise });
                }
            });
            setSelectedIds(pending.map((p) => p.id));

            for (const { id, promise } of pending) {
                promise
                    // Untracked, so the drop's insert stays its one undo step, as a paste's does. Peers still receive
                    // the real name.
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

    // Images picked in Drive copy into the media folder, are measured, then land at natural size around the viewport
    // center in one undo step. They are measured by the copy's own path, because by name the media listing from before
    // the copy would miss them.
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
            // The whole batch is one undo step.
            const ids = sealed(undoManager, () =>
                addElements(measured.map(({ name }, i) => ({ type: 'image' as const, ...boxes[i], mediaName: name }))),
            );
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

    // Insert › Chart places the sample chart at the viewport center, selected, in one undo step.
    const insertChart = useCallback(
        (type: ChartType) => {
            const id = sealed(undoManager, () =>
                addElement(newChartElement(type, viewportCenterScene(), viewport, styleDefaults)),
            );
            if (id) setSelectedIds([id]);
        },
        [undoManager, addElement, viewportCenterScene, viewport, styleDefaults, setSelectedIds],
    );

    // Images insert only where there is a folder to upload into, which a new drawing has, and not while a text editor
    // owns paste and the pointer.
    const imagesEnabled = canEdit && !!mediaFolderId && !textEditing;
    // ⌘C, ⌘X, ⌘V, the menu's clipboard rows and every paste live in a sibling hook. The canvas hands it the scene, the
    // selection and its writers.
    const { onMenuCopy, onMenuCut, onMenuPaste, pasteSvgText, downloadImage } = useCanvasClipboard({
        canEdit,
        textEditingRef,
        containerRef,
        viewport,
        frameId,
        styleDefaults,
        ordered,
        meta,
        selectedIds,
        setSelectedIds,
        addElements,
        updateElements,
        updateElementsUntracked,
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

    // Publishes the handle for the host. It is cleared on unmount, so a stale canvas never places or pans.
    useEffect(() => {
        if (!canvasRef) return;
        canvasRef.current = {
            insertFiles: (files) => void insertImageFiles(files, viewportCenterScene()),
            insertDrivePaths,
            insertChart,
            centerOn: (el) => {
                const box = elementBox(el);
                centerOn(box.x + box.width / 2, box.y + box.height / 2);
            },
            downloadDrawing: () => downloadImage(imageName, ordered, meta.background),
        };
        return () => {
            canvasRef.current = null;
        };
    }, [
        canvasRef,
        insertImageFiles,
        viewportCenterScene,
        insertDrivePaths,
        insertChart,
        centerOn,
        downloadImage,
        imageName,
        ordered,
        meta.background,
    ]);

    // In frame mode the backdrop around the page is not the canvas: the frame clips what overhangs it, so an element
    // created there, and the editor over it, would be invisible. The infinite canvas has no page, so nothing is off it.
    const offPage = (p: Point) => !!frame && !pointInFrame(p, frame);

    // The drop target stays enabled, so dragover and drop are always prevented. A disabled one would let the browser
    // navigate to a file dropped while read-only or mid-edit, which destroys the editor and the text not yet written.
    // The callback gates the insert instead, and the drag-over hint shows only when a drop would insert.
    const { targetProps: fileDropProps, isDragging } = useFileDropTarget((files, e) => {
        if (!imagesEnabled) return;
        const dropped = e ? clientToScene(e.clientX, e.clientY) : viewportCenterScene();
        // A drop on the backdrop lands on the page instead of being ignored, because the files are already here.
        const anchor = offPage(dropped) ? viewportCenterScene() : dropped;
        // An SVG we exported carries its elements in a `<metadata>` block, so dropping one restores them as pasting one
        // does. Otherwise the same file would behave differently by how it arrived. Any other SVG is an image.
        const svgFile = files.length === 1 && files[0].type === 'image/svg+xml' ? files[0] : null;
        if (svgFile) {
            void svgFile
                .text()
                .then((svg) => {
                    if (!pasteSvgText(svg)) void insertImageFiles(files, anchor);
                })
                .catch(() => void insertImageFiles(files, anchor));
            return;
        }
        void insertImageFiles(files, anchor);
    });
    // The file paste target stays gated: disabled, it prevents nothing, which is harmless, and text pastes pass on.
    const { onPaste } = useFilePasteTarget((files) => {
        void insertImageFiles(files, viewportCenterScene());
    }, imagesEnabled);

    // Whether an edit may start: the select tool, no session open, and no live gesture to open a session over.
    const mayEdit = () => canEdit && tool === 'select' && !textEditing && !frozenRef.current;

    // What opening an element does, for a double-click, a double tap and Enter. An arrow opens its label editor, a kind
    // with an edit dialog opens that, such as a chart's data, and an element that holds text opens the in-place editor
    // inside its own layer. Anything else does nothing. It says whether it opened anything.
    const editElement = (el: VectorElement) => {
        if (!mayEdit()) return false;
        if (el.type === 'arrow') return openEditArrowLabel(el);
        if (ELEMENT_KIND_UI[el.type].EditDialog) {
            setEditDialogId(el.id);
            return true;
        }
        if (!isTextual(el)) return false;
        openRichText(el.id);
        return true;
    };

    // Text editing from a mouse double-click or a touch double tap, which the touch policy makes out of two taps. An
    // element opens as editElement says. Empty canvas places a new text box there, as Excalidraw's openNewText does and
    // as the Text tool's click does: the starting box with its corner on the point.
    const openTextAtClient = (clientX: number, clientY: number) => {
        if (!mayEdit()) return;
        const p = clientToScene(clientX, clientY);
        if (offPage(p)) return;
        const hit = hitTestTopmost(ordered, p, viewportRef.current.zoom, committedById, coarse);
        const hitEl = hit ? ordered.find((el) => el.id === hit) : undefined;
        if (hitEl) return editElement(hitEl);
        const id = sealed(undoManager, () =>
            addElement({ ...boxToolElement('text'), x: p.x, y: p.y, ...NEW_TEXT_BOX_SIZE }),
        );
        if (id) openRichText(id);
    };
    const onDoubleClick = (e: React.MouseEvent) => openTextAtClient(e.clientX, e.clientY);

    // A right-click on an element opens the object menu, and on empty canvas the background menu. A right-click on an
    // element outside the selection selects it first, so the menu acts on it, and one inside the selection keeps the
    // whole selection. Elements have no DOM node of their own to listen on, so this hit-tests on the container.
    const onContextMenu = (e: React.MouseEvent) => {
        // No menu over a live left-button gesture, such as a marquee, which keeps its capture.
        if (textEditing || frozenRef.current) return;
        // A line drawn point by point runs unfrozen but still owns the pointer, so no menu opens mid-draft. The draft
        // keeps following the pointer and the next left click places a point.
        if (drawing.multiPointDraft) {
            e.preventDefault();
            return;
        }
        const p = clientToScene(e.clientX, e.clientY);
        const hitId = hitTestTopmost(ordered, p, viewportRef.current.zoom, committedById, coarse);
        // A viewer's menu is the download alone, which an image without its file yet doesn't have.
        if (!canEdit) {
            const hit = hitId ? committedById.get(hitId) : undefined;
            if (hit && (hit.type !== 'image' || resolveMediaPath(hit.mediaName)))
                objectContextMenu.handleContextMenu(e, hit.id);
            return;
        }
        if (!hitId) {
            backgroundContextMenu.handleContextMenu(e, true);
            return;
        }
        if (!selectedIds.includes(hitId)) setSelectedIds([hitId]);
        objectContextMenu.handleContextMenu(e, hitId);
    };

    // The menu acts on the whole selection through the same writes as ⌘[, ⌘], ⌘D and Delete, so the menu and the keys
    // behave as one, each in one undo step.
    const onMenuArrange = (op: ZOp) => applyZOrder(op, visibleElements, selectedIds, reorderElements, undoManager);
    const onMenuDuplicate = () => duplicateSelection(selectedIds, duplicateElements, setSelectedIds, undoManager);
    const onMenuDelete = () => deleteSelection(selectedIds, deleteElements, setSelectedIds, undoManager);
    // A comment is raised on the right-clicked element, not on the selection: a card anchors to one element.
    const menuItemId = objectContextMenu.item;
    const menuElement = menuItemId ? committedById.get(menuItemId) : undefined;
    // Download image draws the selection, or for a viewer, who selects nothing, the element right-clicked. A single
    // image downloads only its original file.
    const menuSelection = canEdit
        ? ordered.filter((el) => selectedIds.includes(el.id))
        : menuElement
          ? [menuElement]
          : [];
    const onMenuDownloadImage =
        menuItemId && !(menuSelection.length === 1 && menuSelection[0].type === 'image')
            ? () => downloadImage(canvasImageName(menuSelection, imageName), menuSelection)
            : undefined;
    // Laid out only while the menu is open.
    const menuShapes = useMemo(
        () => (menuItemId ? selectionShapes(selectedIds, committedById) : []),
        [menuItemId, selectedIds, committedById],
    );
    const editDialogElement = editDialogId ? committedById.get(editDialogId) : undefined;
    const EditDialog = editDialogElement ? ELEMENT_KIND_UI[editDialogElement.type].EditDialog : undefined;
    const onMenuConvertToShapes = () =>
        convertElementToShapes(selectedIds[0], menuShapes, replaceElement, setSelectedIds, undoManager);
    // The touch and stylus policy lives in a sibling module, and the canvas only dispatches to it. A second finger ends
    // the live one-finger gesture through abortActiveGesture: a drawing draft in the tools hook, or else the canvas's
    // own create, move or marquee.
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
        // Read first: Radix closes the menu on this same press, and a touch handler may take its turn before the check.
        const closesMenu = pressClosesMenu();
        // Focus the container, which has tabIndex -1, so a paste after this lands on our onPaste. A bare canvas div
        // never holds focus, so an image paste would otherwise go past it to the body.
        containerRef.current?.focus();
        // Touch gestures go first, because a second finger must take over even while frozen.
        if (touch.onPointerDown(e)) return;
        // A press that closes an open menu, such as File, only closes it.
        if (closesMenu) return;
        // The open text editor stops its own presses, so a press that reaches the container lands outside
        // it and ends the session. The session's effect lifts the viewport freeze on the next render. So
        // this click only closes the editor, and the next one selects or draws.
        if (richTextEditRef.current) closeRichText();
        // The surface is select-none, so a run selected elsewhere would survive this click and keep ⌘C and ⌘X from the
        // element it selects.
        dropOutsideTextSelection(containerRef.current);
        if (frozenRef.current) return; // a gesture is already live
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
        // A creation gesture starting on the backdrop is ignored. Select and eraser still work out
        // there, so a marquee may sweep across the page from outside.
        if (tool !== 'select' && tool !== 'eraser' && offPage(p)) return;

        // A freehand stroke, a line and the eraser run their own gestures. The tools hook takes the event for those
        // tools, and the canvas does nothing more.
        if (drawing.onPointerDown(e, p)) return;

        containerRef.current?.setPointerCapture(e.pointerId);

        // A box tool starts a drag-create in local state. A text box drags out like a shape, and a click under the
        // threshold places the default box instead of discarding it, as finishGesture does.
        if (isBoxTool(tool)) {
            frozenRef.current = true;
            undoManager?.stopCapturing();
            setSelectedIds([]);
            gestureRef.current = { kind: 'create', pointerId: e.pointerId, startX: p.x, startY: p.y };
            setCreating({
                tool,
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

        // A press on empty space starts a marquee. Shift adds to the selection, and a plain press clears it first.
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
        // A two-finger pan or pinch takes the move before any one-pointer gesture sees it.
        if (touch.onPointerMove(e)) return;
        // The local cursor is published on every move, throttled downstream and with no React state, so nothing
        // re-renders. Then the live gesture, if any, runs.
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
        // A freehand stroke, an eraser swipe or a line draft, with its hover point, is handled by the tools hook, which
        // takes the move.
        if (drawing.onPointerMove(e)) return;
        // The idle select tool's hover: one hit test on this move sets the `move` cursor. A gesture never pays for it.
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
                // A square or a circle: the longer axis wins.
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
                // Shift locks the move to the longer axis.
                if (Math.abs(dx) < Math.abs(dy)) dx = 0;
                else dy = 0;
            }
            if (dx !== 0 || dy !== 0) g.moved = true;

            const selById = g.selById;
            const selEls = [...selById.values()];
            // The selection's bounding box snaps to the other elements, by its center only when any member is turned,
            // and the correction moves every element. No lines means no snap. An axis Shift locked goes to the snap as
            // lockAxis, so it never gives a correction or a guide line to undo here.
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
        // A marquee's direction picks its mode: rightward it selects what it contains, leftward what it touches. It is
        // read from the raw x values, before normalizeRect drops the direction.
        const box = normalizeRect(g.startX, g.startY, p.x, p.y);
        const mode = marqueeMode(g.startX, p.x);
        setMarquee({ box, mode });
        const hits = marqueeSelect(ordered, boxToBounds(box), mode, committedById);
        setSelectedIds(g.additive ? [...new Set([...g.base, ...hits])] : hits);
    };

    const finishGesture = (altKey = false) => {
        const g = gestureRef.current;
        // With no gesture there is nothing to finish, and the freeze must stay. A text session freezes the viewport
        // with no gesture, and this runs on the session's opening pointerup and on every caret click inside the editor.
        // Lifting the freeze here would let a wheel zoom or pan the scene from under the editor. Only a real gesture
        // lifts it.
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
            // A drag under the threshold is a click. A shape is discarded, but a text box is placed at its default
            // size, because a click is how you start typing.
            const clicked = c.box.width < CREATE_MIN_SIZE && c.box.height < CREATE_MIN_SIZE;
            if (clicked && c.tool !== 'text') return;
            // A click places the engine's starting box, so both apps agree, and a drag keeps what the user drew. Either
            // way the height only grows from there.
            const box = clicked ? { ...c.box, ...NEW_TEXT_BOX_SIZE } : c.box;
            const id = addElement({
                ...boxToolElement(c.tool),
                x: box.x,
                y: box.y,
                width: Math.max(MIN_ELEMENT_SIZE, box.width),
                height: Math.max(MIN_ELEMENT_SIZE, box.height),
                seed: c.seed,
            });
            if (id) setSelectedIds([id]);
            // The trailing seal keeps anything inside the 500 ms window out of this gesture's undo step. The leading
            // seal fired at pointerdown.
            undoManager?.stopCapturing();
            // A new text box opens its editor at once: an empty box you cannot type into is not a text tool.
            if (id && c.tool === 'text') openRichText(id);
            return;
        }
        if (g.kind === 'move') {
            if (g.moved) {
                // An Alt-drag duplicates. The drag showed only local previews, so the copies are written at the
                // gesture's end in one write and one undo step, and the originals stay put. A plain drag writes the
                // move.
                const anchor = g.ids.find((id) => previews[id] && g.originals[id]);
                const dx = anchor ? previews[anchor].x - g.originals[anchor].x : 0;
                const dy = anchor ? previews[anchor].y - g.originals[anchor].y : 0;
                if (altKey && (dx !== 0 || dy !== 0)) {
                    const ids = duplicateElements(g.ids, dx, dy);
                    undoManager?.stopCapturing(); // the trailing seal
                    if (ids.length) setSelectedIds(ids);
                } else {
                    // Past the unbind distance, a dragged arrow lets go of a bound shape it left behind. A shape
                    // dragged along stays bound, because updateElements docks the arrow again.
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
                    undoManager?.stopCapturing(); // the trailing seal
                }
            }
            setPreviews({});
            setSnapLines([]);
            return;
        }
        // A marquee set the selection live during the move, and a plain click already cleared it.
        setMarquee(null);
    };
    finishRef.current = finishGesture;

    const onPointerUp = (e: React.PointerEvent) => {
        // Touch goes first: it ends a pinch, or fires a double tap, which ends its own gesture and claims the up.
        if (touch.onPointerUp(e)) return;
        const g = gestureRef.current;
        // A freehand stroke, a line or an eraser swipe finishes and writes through the tools hook. A pan, the one
        // canvas gesture that can run during a line draft, ends here.
        if (g?.kind !== 'pan' && drawing.onPointerUp(e)) return;
        if (g && e.pointerId !== g.pointerId) return;
        // Alt is read off the last event, so the modifier at the drop decides an Alt-drag duplicate.
        finishGesture(e.altKey);
    };

    // The scan of every element is memoized. The map over the selection reads the live previews, so it runs each render.
    const selectedElements = useMemo(() => ordered.filter((el) => selectedIds.includes(el.id)), [ordered, selectedIds]);
    const selectedRender = selectedElements.map(renderEl);
    const single = selectedRender.length === 1 ? selectedRender[0] : null;
    // elementBounds knows arrows, so the ring around the selection encloses a labeled arrow's overhang and an elbow
    // arrow's bends, through arrowRoute and the previews in renderById.
    const unionBox = selectedRender.length >= 1 ? boundsToBox(sceneBounds(selectedRender, renderById)) : null;
    // A single line or arrow with two points, and any elbow arrow, gets no transform box: its round end dots, and an
    // elbow's pin dots, are its whole affordance. The elbow check asks `elbow`, not the stored point count, because a
    // pinned elbow stores its whole polyline. A straight line of three or more points keeps the box.
    const singleLinear2pt =
        single !== null &&
        (single.type === 'line' || single.type === 'arrow') &&
        ((single.type === 'arrow' && single.elbow) || parsePoints(single.points).length <= 2);
    // The chrome hides during a create or marquee drag, so the grips don't flicker, during a vertex drag, so no stale
    // box lingers over the reshaped draft, and while a text editor is open. A move keeps it.
    const showChrome = !creating && !marquee && !textEditing && !drawing.active && !drawing.hiddenId;
    const showTransform = showChrome && canEdit && single !== null && !singleLinear2pt;

    const cursor = pointerCursor({ panning, panMode, tool, hoveringSelectable });
    // The scene paints the infinite canvas's background. A frame paints its own, and the surface around it stays the
    // app's, so a letterboxed page reads as a page.
    const background = viewport === 'infinite' && !isTransparentColor(meta.background) ? meta.background : undefined;

    // A text box's height follows its text, so the layer that renders a box measures it and writes the fit back here. A
    // fit the typing user caused joins their own undo step: the box grew because of that keystroke, and the fit only
    // grows, so ⌘Z must take back both. Every other fit, such as after a peer's edit, a load or a panel change, is
    // bookkeeping and stays untracked. No fit runs while a gesture is live: a resize preview owns the box it drags, and
    // the committed width fits it again once the drag ends.
    const fitElementHeight = useCallback(
        (id: string, height: number, editing: boolean) =>
            editing ? updateElement(id, { height }) : updateElementUntracked(id, { height }),
        [updateElement, updateElementUntracked],
    );
    const onFitHeight = canEdit && !hasPreviews && !creating ? fitElementHeight : undefined;
    // An arrow label's width follows its text and font, so it is no step of the user's and stays untracked. The user's
    // own step is the text or font change that caused it, and ⌘Z on that change measures the label it brings back.
    useArrowLabelFit(elements, canEdit ? updateElementsUntracked : undefined);

    // One scene node. Every render path goes through here, so `byId`, an elbow arrow's route context, is passed in one
    // place.
    const node = (el: VectorElement, children?: ReactNode) => (
        <ElementLayer key={el.id} el={el} resolveMedia={resolveMediaUrl} byId={renderById} onFitHeight={onFitHeight}>
            {children}
        </ElementLayer>
    );

    // Every element's layer, in z-order, and then the shape being created and the freehand or point-edit draft.
    const layers = (
        <>
            {ordered.map((el) => {
                // A line being vertex-dragged is drawn by the drawing preview below instead.
                if (drawing.hiddenId === el.id) return null;
                // Only an arrow label opens the label editor, so the arrow under edit keeps its shaft and heads and
                // hides just the label, which the textarea draws.
                if (editing?.id === el.id && el.type === 'arrow') return node(renderEl({ ...el, text: '' }));
                // The layer still paints the box's backdrop. Only its text body gives way to the in-place editor
                // inside it, which is styled with the same CSS the renderer would have written.
                if (el.id === richTextEditId && isTextual(el)) {
                    return node(
                        renderEl(el),
                        <RichTextInPlaceEditor
                            element={el}
                            onChange={(fields) => updateElement(el.id, fields)}
                            onExit={closeRichText}
                        />,
                    );
                }
                return node(renderEl(el));
            })}
            {creating && node(creatingElement(creating, styleDefaults))}
            {/* A live freehand or line draft, or a point-edit reshape, through the same render path. */}
            {drawing.previewElement && node(drawing.previewElement)}
        </>
    );

    // A frame is a page, drawn as a card by FramePage: the paint, the rounded clip and the light paper. Its border is
    // drawn in the screen-space chrome layer below, where a 1 px border is really 1 px. The infinite canvas has no such
    // box, so its layers sit straight on the scene.
    const frameLayers = frame ? (
        <FramePage frame={frame} zoom={zoom} resolveMediaUrl={resolveMediaUrl}>
            {layers}
        </FramePage>
    ) : (
        layers
    );

    return (
        // The surface: on the infinite canvas it is the paper itself, light in dark mode too, and its paint must stay
        // opaque, or the dark app surface would bleed through a translucent tint. In frame mode it is the themed
        // backdrop around the page. See canvasSurfaceClass.
        <div
            ref={containerRef}
            tabIndex={-1}
            // overflow-clip for the same reason the page below uses it: the infinite canvas is not a
            // scroll container, so a caret scroll must not be able to slide the scene under the chrome.
            className={cn(
                'relative h-full w-full select-none overflow-clip touch-none outline-none',
                canvasSurfaceClass(frame !== undefined),
            )}
            style={{ cursor, backgroundColor: background }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            // Our cursor is hidden from peers when the pointer leaves, unless a gesture holds capture, because the
            // pointer may roam outside the container mid-drag.
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
            // A press is the canvas's gesture. With text selected over the scene, Safari drags that selection from any
            // press, and Chrome from selectable text, and the page then gets no pointerup. A drag that starts in a text
            // editor stays its own, and a selection's drag starts at its text node.
            onDragStart={(e) => {
                const from = e.target instanceof Text ? e.target.parentElement : e.target;
                const editor =
                    from instanceof HTMLTextAreaElement || (from instanceof HTMLElement && from.isContentEditable);
                if (!editor) e.preventDefault();
            }}
            {...fileDropProps}
        >
            {/* The scene, in scene units, one layer div per element. It takes no pointer events, because the hit test
                is geometry on the container, never a DOM hit test. The viewport writes the transform of this node, and
                of the two below, itself, so a pan or zoom moves them without a React render. */}
            <div ref={sceneRef} className="pointer-events-none absolute inset-0 origin-top-left">
                {frameLayers}
            </div>
            {/* The scene-space chrome stays SVG, so the guides and the binding hints turn and zoom with the scene for
                free. */}
            <svg
                className={cn(CANVAS_PAPER_CLASS, 'pointer-events-none absolute inset-0 h-full w-full')}
                xmlns={SVG_NS}
            >
                <g ref={overlayRef}>
                    <SnapGuides lines={snapLines} />
                    {drawing.bindingOutline}
                    {drawing.snapDots}
                    {drawing.focusIndicators}
                </g>
            </svg>
            {/* The screen-space chrome, laid out by boxToStyle at the viewport React last rendered. A live gesture
                moves the whole layer with one transform, chromeTransform, instead. It dresses the page, so it takes the
                page's palette and not the app's: the paper pin keeps a resize grip white on a white slide in dark mode.
                The infinite canvas is paper already. */}
            <div
                ref={chromeRef}
                className={cn(CANVAS_PAPER_CLASS, 'pointer-events-none absolute inset-0 origin-top-left')}
            >
                {/* The page card's border, in screen px, because the scene layer paints and clips the page. It comes
                    first, so the selection chrome draws over it. */}
                {frame && (
                    <div
                        className="pointer-events-none absolute border-border"
                        style={{
                            ...boxToStyle({ x: 0, y: 0, width: frame.width, height: frame.height, angle: 0 }),
                            borderWidth: FRAME_CARD_BORDER,
                            borderRadius: FRAME_CARD_RADIUS,
                        }}
                    />
                )}
                {/* Elements that paint nothing, ringed while editing so they stay findable. */}
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
                        // The shared aspect lock: Shift frees a locked resize.
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
                            // Only the fields the gesture changed are written, so a rotate never writes stale values
                            // over a peer's move or resize.
                            const fields: VectorElementPatch = {};
                            if (next.x !== start.x) fields.x = next.x;
                            if (next.y !== start.y) fields.y = next.y;
                            if (next.angle !== start.angle) fields.angle = next.angle;
                            if (isLinearElement(single)) {
                                // A linear element scales its points to the new box through resizeLinear, which reads
                                // the committed element so the total scale is exact.
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
                                undoManager?.stopCapturing(); // the trailing seal
                            }
                            setPreviews({});
                            setSnapLines([]);
                        }}
                    />
                )}
                {/* Comment marks, last in the chrome layer, so the transform box's top-right grip, which sits on the
                    corner a mark claims, never covers one. They are in screen space like the selection ring, so they
                    keep their size at any zoom. */}
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
                                // The container captures the pointer on its own pointerdown, so the click that would
                                // follow never lands here. The mark opens from the pointer event itself, and keeps the
                                // press off the canvas so it starts no drag.
                                onPointerDown={(e) => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    onOpenCard(cardId);
                                }}
                                // The pointerdown above swallows the click it would become, so the keyboard needs its
                                // own opener. preventDefault keeps Enter and Space from making a second one.
                                onKeyDown={(e) => {
                                    if (e.key !== 'Enter' && e.key !== ' ') return;
                                    e.preventDefault();
                                    onOpenCard(cardId);
                                }}
                                aria-label="Open comment"
                                title="Open comment"
                            >
                                <CommentIndicator color={color} className="block" />
                            </button>
                        );
                    })}
                {/* Round vertex handles: over the box for a line of three or more points, and the only chrome for one
                    of two. */}
                {drawing.handles}
                {/* A dashed ring around a multiple selection, or a read-only single one. A line or arrow of two points
                    the user can edit shows only its handles. */}
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
                        color={editing.strokeColor}
                        onCommit={commitEditing}
                    />
                )}
                {/* Remote peers' cursors and selection rings, in screen space with their own subscription, above the
                    local chrome. With no peers it draws nothing. */}
                <CursorLayer
                    provider={provider}
                    boxes={cursorBoxes}
                    boxToStyle={boxToStyle}
                    isPeerVisible={isPeerVisible}
                />
            </div>
            {/* The OS-file drag-over hint, shown only when a drop would insert, though the drop target stays enabled
                when it wouldn't. It is paper-pinned like the chrome layer: its border and label are `primary`, which in
                dark mode is near white, and over a framed canvas's light page that is white on white. */}
            <FileDropOverlay
                visible={isDragging && imagesEnabled}
                label="Drop images to add"
                icon={ImageIcon}
                className={CANVAS_PAPER_CLASS}
            />
            {/* A hint for a line drawn point by point, because its finish keys are not discoverable. It shows while the
                clicks are collected, paper-pinned for the same reason as the drop hint. */}
            {drawing.multiPointDraft && (
                <HintPill className={cn(CANVAS_PAPER_CLASS, 'bottom-3 left-1/2 -translate-x-1/2')}>
                    Enter or double-click to finish · Esc to cancel
                </HintPill>
            )}
            {/* The zoom readout. A click resets it to 100% about the viewport center. It sits bottom right, because the
                router devtools badge owns the bottom left in dev. A framed page always shows the whole page, so it has
                no zoom and no readout. */}
            {viewport === 'infinite' && (
                <HintPill className={cn(CANVAS_PAPER_CLASS, 'bottom-3 right-3')} title="Reset zoom" onClick={resetZoom}>
                    {Math.round(zoom * 100)}%
                </HintPill>
            )}
            <ObjectContextMenu
                contextMenu={objectContextMenu}
                canEdit={canEdit}
                imagePath={menuElement?.type === 'image' ? resolveMediaPath(menuElement.mediaName) : undefined}
                onDownloadImage={onMenuDownloadImage}
                onArrange={onMenuArrange}
                onCut={onMenuCut}
                onCopy={onMenuCopy}
                onPaste={onMenuPaste}
                onDuplicate={onMenuDuplicate}
                onDelete={onMenuDelete}
                onConvertToShapes={menuShapes.length > 0 ? onMenuConvertToShapes : undefined}
                onComment={onAddComment && menuItemId ? () => onAddComment(menuItemId) : undefined}
            />
            <ContextMenuAnchor contextMenu={backgroundContextMenu} className="min-w-48">
                <MenuSections {...backgroundMenu} clipboard={<ClipboardMenuItems onPaste={onMenuPaste} />} />
            </ContextMenuAnchor>
            {editDialogElement && EditDialog && (
                // Portaled to the body, but React bubbles its events up this tree, and the canvas's own pointer,
                // double-click and paste handlers must not act on a click or a paste in the dialog.
                <div
                    className="contents"
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerMove={(e) => e.stopPropagation()}
                    onPointerUp={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => e.stopPropagation()}
                    onPaste={(e) => e.stopPropagation()}
                    onDragStart={(e) => e.stopPropagation()}
                >
                    <EditDialog
                        element={editDialogElement}
                        onChange={(fields) => sealed(undoManager, () => updateElement(editDialogElement.id, fields))}
                        onClose={() => setEditDialogId(null)}
                    />
                </div>
            )}
        </div>
    );
}
