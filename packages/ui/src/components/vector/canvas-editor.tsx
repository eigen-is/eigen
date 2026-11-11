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
import type { CommentCard, CommentHoverTarget } from '@workspace/lib/types/comments';
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
import { useCallback, useEffect, useEffectEvent, useImperativeHandle, useMemo, useRef, useState } from 'react';
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
    selectAllElements,
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
// never detaches it.
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

// What the canvas offers its host, such as the toolbar's Insert and Edit rows, which need the live viewport or act on
// the selection as the object menu's rows do, and a reveal for ⌘F or a comment card, which pans at the current zoom.
export type CanvasHandle = {
    insertFiles: (files: File[]) => void;
    insertDrivePaths: (paths: DrivePath[]) => Promise<void>;
    insertChart: (type: ChartType) => void;
    centerOn: (el: VectorElement) => void;
    // Every element the canvas shows, on its background, as the SVG the browser draws, such as for File › Download.
    downloadDrawing: () => void;
    cut: () => void;
    copy: () => void;
    paste: () => void;
    selectAll: () => void;
    duplicate: () => void;
    delete: () => void;
};

type CanvasEditorProps = {
    // The host's document: the scene and every writer, taken whole rather than threaded prop by prop.
    doc: CanvasDoc;
    // 'infinite' is the drawing canvas. 'frame' bounds it to one page: the canvas then renders, hit-tests, snaps and
    // creates inside `frameId` only, and a pan can't push the page off screen.
    viewport: 'infinite' | 'frame';
    // The active frame, or '' on the infinite canvas: the home stamped on every new element.
    frameId?: string;
    // The host's style table, the same one its useCanvasDoc writes through, so a drag-create preview looks exactly like
    // the element that lands.
    styleDefaults: StyleDefaults;
    tool: VectorTool;
    setTool: (tool: VectorTool) => void;
    // The tool lock keeps the tool after a placement. The host owns it, like `tool`, and Q or the padlock toggles it.
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
    canvasRef: { current: CanvasHandle | null };
    // Whether a text editor is open on the canvas, for the host's toolbar, whose Edit rows stand down as the keys do.
    onTextEditingChange: (textEditing: boolean) => void;
    // Comments. A commented element shows a mark at its top-right corner, and a click on the mark opens its first card,
    // which the host reveals. Without onOpenCard there are no marks, and without onAddComment no menu row.
    onOpenCard?: (cardId: string) => void;
    // The document's cards, for the mark's color, which is the card's own, as on a commented sheet cell.
    commentCards?: Readonly<Record<string, CommentCard>>;
    onAddComment?: (elementId: string) => void;
    onCommentHover: (target: CommentHoverTarget | null) => void;
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
    onTextEditingChange,
    onOpenCard,
    commentCards,
    onAddComment,
    onCommentHover,
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
    // Elements store coordinates relative to their frame, so an insert only needs the home frame stamped on it.
    // `frameId` comes after the spread on purpose: a pasted element carries the frame it was copied from.
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
    // Separate from `editing`, the arrow label's session: the two never coexist, and a label commits once on close
    // while rich text writes on every change.
    const [richTextEditId, setRichTextEditId] = useState<string | null>(null);
    // The element whose kind's EditDialog a double-click opened, such as a chart's Edit data.
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

    // Comments and search read the host's `elements` instead, because both must reach an element on another frame.
    const visibleElements = useMemo(
        () => (viewport === 'frame' ? elementsInFrame(elements, frameId) : elements),
        [viewport, elements, frameId],
    );
    const ordered = useMemo(() => orderByFractionalIndex(visibleElements), [visibleElements]);

    // The corner is a zero-size box, so boxToStyle maps it to the screen point at render time.
    const commentedElements = useMemo(
        () =>
            ordered.flatMap((el) => {
                const cardId = parseIdList(el.commentCardIds).find((id) => commentCards?.[id]);
                if (!cardId) return [];
                const box = elementBox(el);
                // The corner travels with the element's rotation, like every other chrome layer, so the mark stays on
                // a rotated shape instead of floating beside it.
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

    // The ringed elements. Only what this canvas renders: a match on another frame is revealed by the host activating
    // that frame, and the ring follows.
    const matchedElements = useMemo(
        () => (searchMatchedIds ? ordered.filter((el) => searchMatchedIds.has(el.id)) : []),
        [ordered, searchMatchedIds],
    );

    // It spans the whole scene on purpose: an elbow arrow inside a frame still routes around a bound shape outside it.
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

    // `busy` hides the point handles while any canvas gesture or overlay owns the surface.
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

    // Hotkeys stand down for a text editor (ignoreInputs misses a ProseMirror contenteditable), an open dialog (Delete
    // on its button would delete the selection) and an open menu, except undo and redo.
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
    // the page away from the editor over it. The host hears of the session too, so its menus grey what the keys skip.
    useEffect(() => {
        if (!textEditing) return;
        frozenRef.current = true;
        onTextEditingChange(true);
        return () => {
            frozenRef.current = false;
            onTextEditingChange(false);
        };
    }, [textEditing, frozenRef, onTextEditingChange]);

    // Safety net: any pointerup ends the freeze and drops leftover previews, because ObjectTransform's Escape and a
    // press that never moved fire no onCommit. A blur can swallow the pointerup, so it finishes a live gesture first.
    useEffect(() => {
        const clear = () => {
            // An open text session owns the freeze until it ends: the opening click's pointerup and every caret click
            // must not lift it.
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

    // ObjectTransform claims Escape during a resize or rotate in the capture phase, so this never fires during a grip
    // drag.
    const escRef = useRef({ hasSelection: false, tool, toolLocked, dialogOpen });
    escRef.current = { hasSelection: selectedIds.length > 0, tool, toolLocked, dialogOpen };
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            // A dialog, a menu or a palette input owns its own Escape. A menu closes in the capture phase and is gone
            // before this runs, but Radix marks the Escape it handled as prevented.
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
                    // A cancel restores the gesture's base: the earlier selection for an additive marquee, nothing for
                    // a plain one.
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

    // The other visible elements' edges and centers (only the center of a turned one) plus the frame's edges and center
    // lines. The threshold is SNAP_SCREEN_THRESHOLD / zoom, so the screen radius is the same at any zoom.
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

    // Finds the moved edge by comparing the box with the committed box, which holds still during a local resize. A
    // turned box doesn't snap, because its axis-aligned edges are not the ones the user sees.
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

    // Mounting is the ready signal (the doc has synced); this tab's own uploads start later. Each id is checked again
    // at removal, since another tab may have finished it, and the delete is untracked so a sweep is never undoable.
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
            // The arrow already exists, so the label's text is written in place. An emptied label clears the text and
            // never deletes the arrow.
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

    // An empty text box that paints nothing is deleted; a shape stays, because the user drew it. It reads the live
    // element, since the session wrote through updateElement and React state may be one tick behind.
    const closeRichText = useCallback(() => {
        const id = richTextEditRef.current;
        richTextEditRef.current = null;
        setRichTextEditId(null);
        if (!id) return;
        const el = visibleRef.current.find((e) => e.id === id);
        if (el && isTextBox(el) && paintsNothing(el)) {
            // Sealed on both sides: without the leading seal the delete would land inside the undo manager's 500 ms
            // window and merge into the session's last keystroke.
            sealed(undoManager, () => deleteElements([id]));
            setSelectedIds([]);
            return;
        }
        // The trailing seal makes the session's writes one undo step.
        undoManager?.stopCapturing();
    }, [deleteElements, setSelectedIds, undoManager]);

    // A paste carries no coordinates, unlike a drop, so it anchors on the visible viewport center.
    const viewportCenterScene = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return { x: 0, y: 0 };
        return clientToScene(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }, [clientToScene, containerRef]);

    // Boxes at natural size for a batch of images, each fitted into the visible viewport without upscaling, centered on
    // `anchor`, and each next one offset by the cascade. Every image insert shares it.
    const imagePlacements = useCallback(
        (intrinsics: (ImageSize | null)[], anchor: Point) => {
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

    // Their sizes are read first, so the adds run as one synchronous batch and one undo step: an await between adds
    // could split it past the undo window.
    const insertImageFiles = useCallback(
        async (files: File[], anchor: Point) => {
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

    // They are measured by the copy's own path, because by name the media listing from before the copy would miss them.
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

    // The menus act on the whole selection through the same writes as the keys, each in one undo step.
    const onMenuDuplicate = () => duplicateSelection(selectedIds, duplicateElements, setSelectedIds, undoManager);
    const onMenuDelete = () => deleteSelection(selectedIds, deleteElements, setSelectedIds, undoManager);

    // Built again on every render, because its rows act on the selection and the scene as last drawn. React clears it
    // on unmount, so a stale canvas never places or pans.
    useImperativeHandle(canvasRef, () => ({
        insertFiles: (files) => void insertImageFiles(files, viewportCenterScene()),
        insertDrivePaths,
        insertChart,
        centerOn: (el) => {
            const box = elementBox(el);
            centerOn(box.x + box.width / 2, box.y + box.height / 2);
        },
        downloadDrawing: () => downloadImage(imageName, ordered, meta.background),
        cut: onMenuCut,
        copy: onMenuCopy,
        paste: onMenuPaste,
        selectAll: () => selectAllElements(visibleElements, setSelectedIds),
        duplicate: onMenuDuplicate,
        delete: onMenuDelete,
    }));

    // In frame mode the backdrop around the page is not the canvas: the frame clips what overhangs it, so an element
    // created there, and the editor over it, would be invisible. The infinite canvas has no page, so nothing is off it.
    const offPage = (p: Point) => !!frame && !pointInFrame(p, frame);

    // The drop target stays enabled so dragover and drop are always prevented: a disabled one lets the browser navigate
    // to a dropped file, which destroys the editor and the text not yet written. The callback gates the insert instead.
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

    // Empty canvas places a new text box there, as the Text tool's click does: the starting box with its corner on the
    // point.
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

    // A right-click on an element outside the selection selects it first, so the menu acts on it. Elements have no DOM
    // node of their own to listen on, so this hit-tests on the container.
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

    const onMenuArrange = (op: ZOp) => applyZOrder(op, visibleElements, selectedIds, reorderElements, undoManager);
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
    // A second finger ends the live one-finger gesture through abortActiveGesture: a drawing draft in the tools hook,
    // or else the canvas's own create, move or marquee.
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
        // The open text editor stops its own presses, so a press that reaches the container lands outside it and ends
        // the session. The next click selects or draws.
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
        // A creation gesture starting on the backdrop is ignored. Select and eraser still work out there, so a marquee
        // may sweep across the page from outside.
        if (tool !== 'select' && tool !== 'eraser' && offPage(p)) return;

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
        // Pan first: a multi-point line draft leaves the surface unfrozen, so a space-pan can start mid-polyline and
        // must keep driving over the draft's trailing point.
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
            // The selection's box snaps to the other elements, by its center only when any member is turned. An axis
            // Shift locked goes to the snap as lockAxis, so it never gives a correction to undo here.
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
        // With no gesture there is nothing to finish and the freeze must stay: a text session freezes the viewport with
        // no gesture, and lifting it here would let a wheel zoom or pan the scene from under the editor.
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
                // An Alt-drag duplicates: the drag showed only local previews, so the copies are written at the end in
                // one write and one undo step.
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

    // The scan of every element is memoized. The map over the selection reads the live previews, so it runs each
    // render.
    const selectedElements = useMemo(() => ordered.filter((el) => selectedIds.includes(el.id)), [ordered, selectedIds]);
    const selectedRender = selectedElements.map(renderEl);
    const single = selectedRender.length === 1 ? selectedRender[0] : null;
    // elementBounds knows arrows, so the ring around the selection encloses a labeled arrow's overhang and an elbow
    // arrow's bends, through arrowRoute and the previews in renderById.
    const unionBox = selectedRender.length >= 1 ? boundsToBox(sceneBounds(selectedRender, renderById)) : null;
    // A line or arrow with two points, and any elbow arrow, gets no transform box: its end dots are the affordance. The
    // elbow check asks `elbow`, not the point count, because a pinned elbow stores its whole polyline.
    const singleDotsOnly =
        single !== null &&
        (single.type === 'line' || single.type === 'arrow') &&
        ((single.type === 'arrow' && single.elbow) || parsePoints(single.points).length <= 2);
    // The chrome hides during a create or marquee drag, so the grips don't flicker, during a vertex drag, so no stale
    // box lingers over the reshaped draft, and while a text editor is open. A move keeps it.
    const showChrome = !creating && !marquee && !textEditing && !drawing.active && !drawing.hiddenId;
    const showTransform = showChrome && canEdit && single !== null && !singleDotsOnly;

    const cursor = pointerCursor({ panning, panMode, tool, hoveringSelectable });
    // The scene paints the infinite canvas's background. A frame paints its own, and the surface around it stays the
    // app's, so a letterboxed page reads as a page.
    const background = viewport === 'infinite' && !isTransparentColor(meta.background) ? meta.background : undefined;

    // A fit the typing user caused joins their undo step (the box grew from that keystroke, so ⌘Z takes back both); any
    // other fit is untracked. No fit runs during a live gesture: a resize preview owns the box it drags.
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

    // A frame is a page drawn as a card by FramePage. Its border is drawn in the screen-space chrome layer below, where
    // a 1 px border is really 1 px.
    const frameLayers = frame ? (
        <FramePage frame={frame} zoom={zoom} resolveMediaUrl={resolveMediaUrl}>
            {layers}
        </FramePage>
    ) : (
        layers
    );

    return (
        // On the infinite canvas the surface is the paper itself, light in dark mode too, and its paint must stay
        // opaque or the dark app surface would bleed through. In frame mode it is the themed backdrop around the page.
        <div
            ref={containerRef}
            tabIndex={-1}
            // overflow-clip for the same reason the page below uses it: the infinite canvas is not a scroll container,
            // so a caret scroll must not be able to slide the scene under the chrome.
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
            // With text selected over the scene, Safari drags it from any press and Chrome from selectable text, and
            // the page then gets no pointerup. A drag that starts in a text editor stays its own.
            onDragStart={(e) => {
                const from = e.target instanceof Text ? e.target.parentElement : e.target;
                const editor =
                    from instanceof HTMLTextAreaElement || (from instanceof HTMLElement && from.isContentEditable);
                if (!editor) e.preventDefault();
            }}
            {...fileDropProps}
        >
            {/* It takes no pointer events, because the hit test is geometry on the container. The viewport writes this
                node's transform and those of the two below itself, so a pan or zoom costs no React render. */}
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
            {/* Laid out at the viewport React last rendered, and a live gesture moves the whole layer with one transform.
                It dresses the page, so the paper pin keeps a resize grip white on a white slide in dark mode. */}
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
                {/* Last in the chrome layer, so the transform box's top-right grip, which sits on the corner a mark
                    claims, never covers one. Screen space keeps them one size at any zoom. */}
                {onOpenCard &&
                    commentedElements.map(({ id, cardId, color, corner }) => {
                        const { left, top } = boxToStyle(corner);
                        return (
                            <CommentMark
                                key={id}
                                cardId={cardId}
                                color={color}
                                style={{ left, top }}
                                onOpenCard={onOpenCard}
                                onCommentHover={onCommentHover}
                            />
                        );
                    })}
                {/* Round vertex handles: over the box for a line of three or more points, and the only chrome for one
                    of two. */}
                {drawing.handles}
                {/* A dashed ring around a multiple selection, or a read-only single one. A line or arrow of two points
                    the user can edit shows only its handles. */}
                {showChrome && !showTransform && unionBox && !(singleDotsOnly && canEdit) && (
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
            {/* Paper-pinned like the chrome layer: its border and label are `primary`, which in dark mode is near white,
                and over a framed canvas's light page that is white on white. */}
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
            {/* Bottom right, because the router devtools badge owns the bottom left in dev. A framed page always shows
                the whole page, so it has no zoom and no readout. */}
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

// An element's comment, in the canvas' chrome. A mark that unmounts under the pointer gets no pointer leave, such as on
// a peer's delete or a slide change, so its unmount reports that instead.
function CommentMark({
    cardId,
    color,
    style,
    onOpenCard,
    onCommentHover,
}: {
    cardId: string;
    color: string | undefined;
    style: React.CSSProperties;
    onOpenCard: (cardId: string) => void;
    onCommentHover: CanvasEditorProps['onCommentHover'];
}) {
    const pointerOnMark = useRef(false);
    const reportGone = useEffectEvent(() => {
        if (pointerOnMark.current) onCommentHover(null);
    });
    useEffect(() => () => reportGone(), []);

    return (
        <button
            type="button"
            // -translate-x-full hangs the triangle inside the box, off the exact corner.
            className="pointer-events-auto absolute -translate-x-full"
            style={style}
            onPointerEnter={(e) => {
                pointerOnMark.current = true;
                onCommentHover({ cardId, rect: e.currentTarget.getBoundingClientRect() });
            }}
            onPointerLeave={() => {
                pointerOnMark.current = false;
                onCommentHover(null);
            }}
            // The container captures the pointer on pointerdown, so no click lands here. The mark opens from the
            // pointer event and keeps the press off the canvas.
            onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onCommentHover(null);
                onOpenCard(cardId);
            }}
            // The pointerdown above swallows the click it would become, so the keyboard needs its own opener.
            // preventDefault keeps Enter and Space from making a second one.
            onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                onOpenCard(cardId);
            }}
            aria-label="Open comment"
        >
            <CommentIndicator color={color} className="block" />
        </button>
    );
}
