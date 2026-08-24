import { useMediaResolver } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    type Bounds,
    type Box,
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_FONT_FAMILY,
    DEFAULT_FONT_SIZE,
    DEFAULT_SHAPE_ROUNDNESS,
    ELEMENT_FIELDS,
    elementToSvg,
    getElementsBounds,
    isTransparent,
    type MediaResolver,
    orderByFractionalIndex,
    type TextAlign,
    type VectorElement,
    type VectorMeta,
    type VectorTextElement,
} from '@workspace/lib/vector';
import { ObjectTransform } from '@workspace/ui/components/transform/object-transform';
import { Image as ImageIcon } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WebsocketProvider } from 'y-websocket';
import type * as Y from 'yjs';
import { isTypingTarget } from '../../hooks/is-typing-target';
import { useFileDropTarget } from '../../hooks/use-file-drop-target';
import { useFilePasteTarget } from '../../hooks/use-file-paste-target';
import { CursorLayer } from '../collab';
import { FileDropOverlay } from '../file-drop-overlay';
import { hitTestTopmost, marqueeContain } from './hooks/use-selection';
import type { VectorTool } from './hooks/use-tool';
import type { NewVectorElement, VectorElementPatch } from './hooks/use-vector-doc';
import { useVectorKeyboard } from './hooks/use-vector-keyboard';
import type { PublishCursor } from './hooks/use-vector-presence';
import { useViewport } from './hooks/use-viewport';
import { isVectorFontLoaded, loadVectorFont, measureVectorText } from './text-measure';
import { TextOverlay } from './text-overlay';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CREATING_ID = '__creating__';
// Below this scene-unit extent (in BOTH dimensions) a drag-create is a click → discarded (SCOUT §7).
const CREATE_MIN_SIZE = 1;
const MIN_ELEMENT_SIZE = 1;
// fontSize clamp for resize-scaling of text (a resize maps width ratio → fontSize).
const MIN_FONT_SIZE = 4;
const MAX_FONT_SIZE = 400;
// A dropped/pasted image fits within this fraction of the visible viewport (never upscaled).
const IMAGE_VIEWPORT_FIT = 0.8;
// Fallback box for an image whose intrinsic size can't be read (e.g. an SVG with no intrinsic
// dimensions) — placed at this size, still run through the 80% viewport cap below.
const DEFAULT_IMAGE_SIZE = { w: 400, h: 300 };
// Each subsequent image in a multi-file drop staggers by this many scene units so a stack of
// natural-size images stays visible (⌘D's +10 is for identical duplicates; images need more).
const IMAGE_CASCADE_OFFSET = 20;

// An open text-editing session. A new element stays LOCAL (id never written) until its first
// commit — an empty discard writes nothing; re-editing an existing element commits one update, or
// deletes it when committed empty.
type EditingState = {
    id: string;
    isNew: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    angle: number;
    text: string;
    fontSize: number;
    fontFamily: string;
    textAlign: TextAlign;
    strokeColor: string;
};

// readVectorFromDoc materializes fresh element objects on every Yjs tick, so identity-based memo
// never hits; every ELEMENT_FIELDS value is a scalar/string, so a field compare is exact. Only
// changed elements re-run elementToSvg — rough path generation is the expensive part.
function sameElement(a: VectorElement, b: VectorElement): boolean {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    for (const field of ELEMENT_FIELDS) {
        if (ra[field] !== rb[field]) return false;
    }
    return true;
}

const ElementNode = memo(
    // Each element is its own node (keyed + `data-element-id`) rendered through the SAME lib render
    // path as previews/embeds/export — elementToSvg emits our own escaped `<g>` fragment.
    function ElementNode({ el, resolveMedia }: { el: VectorElement; resolveMedia?: MediaResolver }) {
        return <g data-element-id={el.id} dangerouslySetInnerHTML={{ __html: elementToSvg(el, { resolveMedia }) }} />;
    },
    (prev, next) => prev.resolveMedia === next.resolveMedia && sameElement(prev.el, next.el),
);

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

function normalizeRect(x0: number, y0: number, x1: number, y1: number): Box {
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), angle: 0 };
}

// Drag-create box: min-corner + extent, or centered on the start point when Alt is held.
function newShapeBox(sx: number, sy: number, dx: number, dy: number, fromCenter: boolean): Box {
    if (fromCenter) {
        return {
            x: sx - Math.abs(dx),
            y: sy - Math.abs(dy),
            width: Math.abs(dx) * 2,
            height: Math.abs(dy) * 2,
            angle: 0,
        };
    }
    return normalizeRect(sx, sy, sx + dx, sy + dy);
}

type CreatingState = { type: 'rectangle' | 'diamond' | 'ellipse'; seed: number; box: Box };

function creatingElement(c: CreatingState): VectorElement {
    return {
        id: CREATING_ID,
        type: c.type,
        x: c.box.x,
        y: c.box.y,
        width: c.box.width,
        height: c.box.height,
        angle: 0,
        ...DEFAULT_ELEMENT_PROPS,
        roundness: DEFAULT_SHAPE_ROUNDNESS,
        seed: c.seed,
        index: 'a0',
    };
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
      }
    | { kind: 'create'; startX: number; startY: number }
    | { kind: 'marquee'; startX: number; startY: number; additive: boolean; base: string[] }
);

type VectorCanvasProps = {
    elements: VectorElement[];
    meta: VectorMeta;
    tool: VectorTool;
    setTool: (t: VectorTool) => void;
    canWrite: boolean;
    addElement: (partial: NewVectorElement) => string | undefined;
    updateElement: (id: string, fields: VectorElementPatch) => void;
    updateElements: (patches: { id: string; fields: VectorElementPatch }[]) => void;
    deleteElements: (ids: string[]) => void;
    duplicateElements: (ids: string[], dx: number, dy: number) => string[];
    undoManager: Y.UndoManager | null;
    // Selection is lifted to the editor so the properties panel and canvas share one source (the
    // slides editor/canvas idiom).
    selectedIds: string[];
    setSelectedIds: (ids: string[]) => void;
    toggle: (id: string) => void;
    // Awareness: the provider drives the CursorLayer's own subscription; publishCursor pushes the
    // local pointer's scene position (throttled in the editor's use-vector-presence).
    provider: WebsocketProvider | null;
    publishCursor: PublishCursor;
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
    canWrite,
    addElement,
    updateElement,
    updateElements,
    deleteElements,
    duplicateElements,
    undoManager,
    selectedIds,
    setSelectedIds,
    toggle,
    provider,
    publishCursor,
}: VectorCanvasProps) {
    const { containerRef, clientToScene, screenDeltaToScene, boxToStyle, groupTransform, panBy, frozenRef, zoom } =
        useViewport();
    // Images resolve/upload through the container's media/ folder (the provider the editor wraps
    // us in). resolveMediaUrl feeds every <image> href; startUpload drives the optimistic insert.
    const { resolveMediaUrl, startUpload, mediaFolderId } = useMediaResolver();

    const [previews, setPreviews] = useState<Record<string, Box>>({});
    const [creating, setCreating] = useState<CreatingState | null>(null);
    const [marquee, setMarquee] = useState<Box | null>(null);
    const [spaceHeld, setSpaceHeld] = useState(false);
    const [panning, setPanning] = useState(false);
    const [editing, setEditing] = useState<EditingState | null>(null);

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

    // Element boxes by id for the shared CursorLayer's remote selection rings — rebuilt only when the
    // scene changes, never on a peer cursor tick (the layer holds its own awareness subscription).
    const cursorBoxes = useMemo(() => {
        const m = new Map<string, Box>();
        for (const el of ordered) m.set(el.id, elementBox(el));
        return m;
    }, [ordered]);

    // An element renders with its live local preview (move/resize/rotate) overriding the Yjs values;
    // no preview → same object identity, so the memo skips it.
    const renderEl = (el: VectorElement): VectorElement => {
        const p = previews[el.id];
        return p ? { ...el, x: p.x, y: p.y, width: p.width, height: p.height, angle: p.angle } : el;
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

    // Space tracks the pan affordance (grab cursor + pan on pointerdown); ignore while typing.
    useEffect(() => {
        const down = (e: KeyboardEvent) => {
            if (e.code === 'Space' && !e.repeat && !isTypingTarget()) setSpaceHeld(true);
        };
        const up = (e: KeyboardEvent) => {
            if (e.code === 'Space') setSpaceHeld(false);
        };
        document.addEventListener('keydown', down);
        document.addEventListener('keyup', up);
        return () => {
            document.removeEventListener('keydown', down);
            document.removeEventListener('keyup', up);
        };
    }, []);

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

    // Open the overlay on a fresh, still-LOCAL text element at the scene point (text tool click on
    // empty canvas / on a non-text hit).
    const openNewText = (x: number, y: number) => {
        setSelectedIds([]);
        setEditing({
            id: '__new_text__',
            isNew: true,
            x,
            y,
            width: 0,
            height: 0,
            angle: 0,
            text: '',
            fontSize: DEFAULT_FONT_SIZE,
            fontFamily: DEFAULT_FONT_FAMILY,
            textAlign: 'left',
            strokeColor: DEFAULT_ELEMENT_PROPS.strokeColor,
        });
    };

    // Open the overlay on an existing text element (text-tool click that hits it, or select-tool
    // double-click) — never stacks a fresh empty on top.
    const openEditExisting = (el: VectorTextElement) => {
        setSelectedIds([el.id]);
        setEditing({
            id: el.id,
            isNew: false,
            x: el.x,
            y: el.y,
            width: el.width,
            height: el.height,
            angle: el.angle,
            text: el.text,
            fontSize: el.fontSize,
            fontFamily: el.fontFamily,
            textAlign: el.textAlign,
            strokeColor: el.strokeColor,
        });
    };

    // The overlay awaits loadVectorFont on open, so commit-time measureVectorText is normally exact.
    // The safety net for the rare commit-before-load-resolves race: if the face isn't loaded, load it
    // and re-measure into the element once it swaps in (self-healing — stored dims are the server
    // renderer's source of truth, and the measurement util stays the sole dim writer). Re-validated
    // against the LIVE element at resolve time: a newer edit (text/font/size) owns the dims, so a
    // slow load can never write stale dims over it — and the single .then can't loop.
    const elementsRef = useRef(elements);
    elementsRef.current = elements;
    const healTextDims = useCallback(
        (id: string, text: string, fontSize: number, fontFamily: string) => {
            if (isVectorFontLoaded(fontSize, fontFamily)) return;
            loadVectorFont(fontSize, fontFamily)
                .then(() => {
                    const el = elementsRef.current.find((x) => x.id === id);
                    if (el?.type !== 'text') return; // deleted meanwhile — nothing to heal
                    if (el.text !== text || el.fontSize !== fontSize || el.fontFamily !== fontFamily) return;
                    const healed = measureVectorText(text, fontSize, fontFamily);
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
            // A text-tool session reverts to select; a double-click session was already select.
            setTool('select');
        },
        [addElement, updateElement, deleteElements, undoManager, setSelectedIds, setTool, healTextDims],
    );

    // A paste carries no coordinates (unlike a drop), so it anchors on the visible viewport center.
    const viewportCenterScene = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return { x: 0, y: 0 };
        return clientToScene(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }, [clientToScene, containerRef]);

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
                images.map(async (file) => {
                    // createImageBitmap rejects on some valid files (e.g. an SVG with no intrinsic
                    // size) — fall back to a default box rather than silently dropping the file; the
                    // 80% viewport cap below still applies.
                    const bmp = await createImageBitmap(file).catch(() => null);
                    if (!bmp) return { file, size: DEFAULT_IMAGE_SIZE };
                    const size = { w: bmp.width, h: bmp.height };
                    bmp.close();
                    return { file, size };
                }),
            );

            const rect = containerRef.current?.getBoundingClientRect();
            const viewW = (rect?.width ?? 0) / zoom;
            const viewH = (rect?.height ?? 0) / zoom;

            undoManager?.stopCapturing();
            const pending: { id: string; promise: Promise<DrivePath | null> }[] = [];
            for (const [i, { file, size }] of measured.entries()) {
                // Fit within 80% of the visible viewport, uniform scale, never upscale.
                const scale = Math.min(1, (IMAGE_VIEWPORT_FIT * viewW) / size.w, (IMAGE_VIEWPORT_FIT * viewH) / size.h);
                const w = size.w * scale;
                const h = size.h * scale;
                const cx = anchor.x + i * IMAGE_CASCADE_OFFSET;
                const cy = anchor.y + i * IMAGE_CASCADE_OFFSET;
                const { pendingName, promise } = startUpload(file);
                const id = addElement({
                    type: 'image',
                    x: cx - w / 2,
                    y: cy - h / 2,
                    width: w,
                    height: h,
                    mediaName: pendingName,
                });
                if (id) pending.push({ id, promise });
            }
            undoManager?.stopCapturing(); // trailing seal — the whole batch is one undo step
            setSelectedIds(pending.map((p) => p.id));

            for (const { id, promise } of pending) {
                promise
                    .then((result) => (result ? updateElement(id, { mediaName: result.name }) : deleteElements([id])))
                    .catch(() => {});
            }
        },
        [
            mediaFolderId,
            zoom,
            startUpload,
            addElement,
            updateElement,
            deleteElements,
            setSelectedIds,
            undoManager,
            containerRef,
        ],
    );

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

    const onDoubleClick = (e: React.MouseEvent) => {
        if (!canWrite || tool !== 'select' || editing) return;
        const p = clientToScene(e.clientX, e.clientY);
        const hit = hitTestTopmost(ordered, p);
        const hitEl = hit ? ordered.find((el) => el.id === hit) : undefined;
        if (hitEl?.type === 'text') openEditExisting(hitEl);
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
            const hit = hitTestTopmost(ordered, p);
            const hitEl = hit ? ordered.find((el) => el.id === hit) : undefined;
            if (hitEl?.type === 'text') openEditExisting(hitEl);
            else openNewText(p.x, p.y);
            return;
        }

        containerRef.current?.setPointerCapture(e.pointerId);

        // Shape tool → start a local (not-yet-Yjs) drag-create.
        if (tool !== 'select') {
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
        const hitId = hitTestTopmost(ordered, p);
        if (hitId) {
            if (e.shiftKey) {
                toggle(hitId); // shift-click toggles membership, no move
                return;
            }
            const ids = selectedIds.includes(hitId) ? selectedIds : [hitId];
            if (!selectedIds.includes(hitId)) setSelectedIds([hitId]);
            const originals: Record<string, { x: number; y: number }> = {};
            for (const id of ids) {
                const el = ordered.find((x) => x.id === id);
                if (el) originals[id] = { x: el.x, y: el.y };
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
        setMarquee({ x: p.x, y: p.y, width: 0, height: 0, angle: 0 });
    };

    const onPointerMove = (e: React.PointerEvent) => {
        // Publish the local cursor on every move (throttled downstream; no React state → no
        // re-render), then handle the active gesture if any.
        publishCursor(clientToScene(e.clientX, e.clientY));
        const g = gestureRef.current;
        if (!g || e.pointerId !== g.pointerId) return;
        if (g.kind === 'pan') {
            panBy(e.clientX - g.lastX, e.clientY - g.lastY);
            g.lastX = e.clientX;
            g.lastY = e.clientY;
            return;
        }
        const p = clientToScene(e.clientX, e.clientY);
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
            const next: Record<string, Box> = {};
            for (const id of g.ids) {
                const o = g.originals[id];
                const el = ordered.find((x) => x.id === id);
                if (!o || !el) continue;
                next[id] = { x: o.x + dx, y: o.y + dy, width: el.width, height: el.height, angle: el.angle };
            }
            setPreviews(next);
            return;
        }
        // marquee
        const box = normalizeRect(g.startX, g.startY, p.x, p.y);
        setMarquee(box);
        const contained = marqueeContain(ordered, boxToBounds(box));
        setSelectedIds(g.additive ? [...new Set([...g.base, ...contained])] : contained);
    };

    const finishGesture = () => {
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
            setTool('select');
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
                const patches = g.ids
                    .filter((id) => previews[id])
                    .map((id) => ({ id, fields: { x: previews[id].x, y: previews[id].y } }));
                if (patches.length) updateElements(patches);
                undoManager?.stopCapturing(); // trailing seal, same as create
            }
            setPreviews({});
            return;
        }
        // marquee: selection was set live during the move; a plain click already cleared it.
        setMarquee(null);
    };
    finishRef.current = finishGesture;

    const onPointerUp = (e: React.PointerEvent) => {
        const g = gestureRef.current;
        if (g && e.pointerId !== g.pointerId) return;
        finishGesture();
    };

    const selectedRender = ordered.filter((el) => selectedIds.includes(el.id)).map(renderEl);
    const single = selectedRender.length === 1 ? selectedRender[0] : null;
    const unionBox = selectedRender.length >= 1 ? boundsToBox(getElementsBounds(selectedRender.map(elementBox))) : null;
    // Chrome is suppressed while a create/marquee drag is in flight (grip flicker) or while a text
    // overlay is open; move keeps it (the ring follows the moving element). Single + write → full
    // transform; everything else → a plain translate-only union ring (multi-select never mounts
    // ObjectTransform, UX-RULING 7).
    const showChrome = !creating && !marquee && !editing;
    const showTransform = showChrome && canWrite && single !== null;

    const cursor = panning
        ? 'grabbing'
        : spaceHeld
          ? 'grab'
          : tool === 'text'
            ? 'text'
            : tool !== 'select'
              ? 'crosshair'
              : 'default';
    const background = isTransparent(meta.background) ? undefined : meta.background;

    return (
        // eigen-paper: the drawing surface always renders light, in dark mode too (globals.css)
        <div
            ref={containerRef}
            tabIndex={-1}
            className="eigen-paper relative h-full w-full select-none overflow-hidden bg-muted/30 touch-none outline-none"
            style={{ cursor, backgroundColor: background }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            // Hide our cursor from peers when the pointer leaves — unless a gesture holds capture (the
            // pointer legitimately roams outside the container mid-drag).
            onPointerLeave={() => {
                if (!gestureRef.current) publishCursor(null);
            }}
            onDoubleClick={onDoubleClick}
            onPaste={onPaste}
            {...fileDropProps}
        >
            <svg className="pointer-events-none absolute inset-0 h-full w-full" xmlns={SVG_NS}>
                <g transform={groupTransform}>
                    {ordered.map((el) =>
                        // The element under edit is drawn only by the overlay textarea (WYSIWYG).
                        editing?.id === el.id ? null : (
                            <ElementNode key={el.id} el={renderEl(el)} resolveMedia={resolveMediaUrl} />
                        ),
                    )}
                    {creating && <ElementNode el={creatingElement(creating)} resolveMedia={resolveMediaUrl} />}
                </g>
            </svg>
            <div className="pointer-events-none absolute inset-0">
                {showTransform && single && (
                    <ObjectTransform
                        box={elementBox(single)}
                        boxToStyle={boxToStyle}
                        screenDeltaToScene={screenDeltaToScene}
                        showRotate
                        // Text has derived dims + no wrap, so only corners, aspect always locked; a
                        // resize maps the width ratio → fontSize, then re-measures (see onCommit).
                        // Images resize aspect-locked by default (Shift frees), all 8 grips.
                        resizeMode={
                            single.type === 'text' ? 'aspect' : single.type === 'image' ? 'aspect-default' : 'free'
                        }
                        minSize={MIN_ELEMENT_SIZE}
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
                            } else {
                                if (next.width !== start.width) fields.width = next.width;
                                if (next.height !== start.height) fields.height = next.height;
                            }
                            if (Object.keys(fields).length) {
                                updateElement(single.id, fields);
                                undoManager?.stopCapturing(); // trailing seal, same as create/move
                            }
                            setPreviews({});
                        }}
                    />
                )}
                {showChrome && !showTransform && unionBox && (
                    <div
                        className="eigen-selection-ring eigen-selection-ring-dashed pointer-events-none absolute"
                        style={boxToStyle(unionBox)}
                    />
                )}
                {marquee && (
                    <div
                        className="pointer-events-none absolute border border-selection-handle/70 bg-selection-handle/10"
                        style={boxToStyle(marquee)}
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
        </div>
    );
}
