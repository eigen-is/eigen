// The drawing tools (freehand, line, eraser) + line point-handles, factored out of canvas-editor.tsx
// so the canvas only DISPATCHES (the ground-rule that the canvas file must not grow).
// This hook owns the local gesture state (never Yjs until finish), the live preview element rendered
// through the SAME elementToSvg path as committed elements, the eraser's marked-set dimming, and the
// single sealed write per gesture. Escape/Enter/double-click are claimed in the capture phase so the
// innermost active gesture wins over the canvas' layered-Escape (CANVAS.md), exactly as ObjectTransform
// claims Escape mid-resize.

import {
    arrowRoute,
    type Box,
    type CanvasViewport,
    DEFAULT_ELEMENT_PROPS,
    ELEMENT_KINDS,
    elbowBindPoint,
    elbowRoutingContext,
    hitThresholdScreen,
    isBindable,
    linearLocalToScene,
    normalizeLinear,
    type PinPatch,
    type Point,
    parseBinding,
    parsePoints,
    renormalize,
    serializePressures,
    unpinSegment,
    VECTOR_STYLE_DEFAULTS,
    type VectorArrowElement,
    type VectorBindableElement,
    type VectorElement,
    type VectorLinearElement,
} from '@workspace/lib/vector';
import { createElement, Fragment, type MutableRefObject, type ReactNode, useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { isTypingTarget } from '../../../hooks/is-typing-target';
import { randomSeed } from '../hooks/element-writes';
import { type NewVectorElement, sealed, type VectorElementPatch } from '../hooks/use-canvas-doc';
import type { VectorTool } from '../hooks/use-tool';
import { FocusIndicators, FocusPointHandles, SnapDots } from './arrow-affordances';
import {
    bindArrow,
    bindElbowEnd,
    bindFocusPoint,
    bindingCandidate,
    bindingOutlineSvg,
    bindPinnedElbowEnd,
    followOtherEnd,
} from './binding';
import { ElbowPinHandles } from './elbow-pin-handles';
import { markErase } from './eraser';
import { extendFreedrawStroke, type FreedrawStroke, startFreedrawStroke } from './freedraw';
import { distinctCount, type LineDraft, previewPoints, snapSegment, startLineDraft } from './line';
import { LinePointHandles } from './point-handles';
import { isFreedrawSpike } from './touch-gestures';

// Screen-px thresholds (÷ the LIVE zoom → constant on-screen distance): the eraser sample step
// (Excalidraw's eraser trail), the freehand minimum sample spacing that thins sub-pixel points, the
// multi-point line's confirm/close radius (LINE_CONFIRM_THRESHOLD), and the drag-vs-click threshold that
// splits a 2-point line from a multi-point one. Hit tolerance is the shared hitThresholdScreen
// (coarse-aware).
const ERASER_STEP_SCREEN = 4;
const FREEDRAW_MIN_STEP_SCREEN = 1;
const LINE_CONFIRM_SCREEN = 8;
const LINE_DRAG_SCREEN = 4;

const PREVIEW_ID = '__drawing__';
const EMPTY_IDS: Set<string> = new Set();

function dist(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

// The geometry + base props every live preview element (draw draft) shares. Its callers spread the kind's
// own create defaults under it — the same table the commit writes through addElement, so a preview can
// never drift from the element that lands. normalizeLinear runs here because the renderer scales roughness
// by the box, so a 0×0 box would pop on release.
function previewBase(origin: Point, points: Point[], seed: number) {
    return {
        id: PREVIEW_ID,
        angle: 0,
        index: 'a0',
        seed,
        ...DEFAULT_ELEMENT_PROPS,
        ...normalizeLinear({ x: origin.x, y: origin.y, width: 0, height: 0, angle: 0 }, points),
    };
}

function previewElement(type: 'freedraw' | 'line', origin: Point, points: Point[], seed: number): VectorLinearElement {
    return {
        ...ELEMENT_KINDS[type].defaults(VECTOR_STYLE_DEFAULTS),
        ...previewBase(origin, points, seed),
        type,
        // The live preview always simulates; real per-point pressure is written on commit (finishFreedraw).
        pressures: '',
        simulatePressure: true,
    };
}

// An arrow preview/commit template — the line geometry plus the default heads and an empty binding/label
// (a draft binds only at commit through bindArrow). Reused as the provisional element bindArrow snaps.
function arrowElement(origin: Point, points: Point[], seed: number): VectorArrowElement {
    return {
        ...ELEMENT_KINDS.arrow.defaults(VECTOR_STYLE_DEFAULTS),
        ...previewBase(origin, points, seed),
        type: 'arrow',
    };
}

type DrawingToolsParams = {
    tool: VectorTool;
    setTool: (t: VectorTool) => void;
    // When the tool lock is on, a finished line/arrow keeps its tool active (freedraw/eraser always do).
    toolLocked: boolean;
    canEdit: boolean;
    // The COMMITTED viewport's zoom — what the screen-space handles/outlines/dots are laid out at, the
    // same value the canvas lays its own chrome out at. Never a gesture threshold; those read the ref.
    zoom: number;
    // The LIVE viewport. A pan/zoom writes it without a React render, so every threshold a pointer
    // handler measures reads its zoom from here or it lags the gesture by a whole pinch.
    viewportRef: MutableRefObject<CanvasViewport>;
    // The active pointer is coarse (finger/stylus) → the eraser and hit paths use a fatter screen slop.
    coarse: boolean;
    ordered: VectorElement[];
    // The committed scene by id — lets the eraser hit-test an elbow arrow on its DERIVED route.
    byId: Map<string, VectorElement>;
    selectedIds: string[];
    // True while a canvas gesture (create/marquee/move/resize) or overlay owns the surface — point
    // handles hide so they don't fight a resize, matching Excalidraw.
    busy: boolean;
    containerRef: MutableRefObject<HTMLDivElement | null>;
    frozenRef: MutableRefObject<boolean>;
    clientToScene: (clientX: number, clientY: number) => Point;
    boxToStyle: (box: Box) => React.CSSProperties;
    addElement: (partial: NewVectorElement) => string | undefined;
    updateElement: (id: string, fields: VectorElementPatch) => void;
    deleteElements: (ids: string[]) => void;
    setSelectedIds: (ids: string[]) => void;
    undoManager: Y.UndoManager | null;
};

type DrawingTools = {
    // A freehand/line/eraser gesture is in flight (chrome is suppressed for it, like create/marquee).
    active: boolean;
    // A multi-point line/arrow draft is collecting clicks — drives the finish hint.
    multiPointDraft: boolean;
    // The in-progress preview element (draw draft or point-edit draft), rendered in the scene group.
    previewElement: VectorElement | null;
    // The committed element hidden while its vertices are being dragged (the preview stands in for it).
    hiddenId: string | null;
    // Elements marked for erasure — the canvas dims them to 20% opacity.
    erasingIds: Set<string>;
    // Screen-space vertex handles for a single selected line/arrow (null otherwise).
    handles: ReactNode;
    // A shape-following outline over the bindable shape a dragged (or hovered) arrow endpoint would bind
    // to — an SVG `<g>` for the scene group (null otherwise).
    bindingOutline: ReactNode;
    // Side-midpoint snap dots over the reached shape, and the straight-arrow focus point — both
    // SVG for the scene group, drawn next to the outline (null otherwise).
    snapDots: ReactNode;
    focusIndicators: ReactNode;
    onPointerDown: (e: React.PointerEvent, scene: Point) => boolean;
    onPointerMove: (e: React.PointerEvent) => boolean;
    onPointerUp: (e: React.PointerEvent) => boolean;
    // A second touch landed: end any live draw draft (spike-discard/finalize) so pan/pinch can take over.
    abortForSecondTouch: () => boolean;
    // Whether the live draw draft was started by a stylus — the touch policy ignores touches during it.
    isPenDrawing: () => boolean;
    // The pointer left the canvas → drop the pre-click hover highlight (no active draft).
    onPointerLeave: () => void;
};

export function useDrawingTools(params: DrawingToolsParams): DrawingTools {
    const {
        tool,
        setTool,
        toolLocked,
        canEdit,
        zoom,
        viewportRef,
        coarse,
        ordered,
        byId,
        selectedIds,
        busy,
        containerRef,
        frozenRef,
        clientToScene,
        boxToStyle,
        addElement,
        updateElement,
        deleteElements,
        setSelectedIds,
        undoManager,
    } = params;

    // Every screen-px threshold below divides by this, never by the `zoom` prop: that one is the last
    // COMMITTED viewport (published on a trailing timer), so mid-gesture it can be a whole pinch stale.
    const liveZoom = () => viewportRef.current.zoom;

    // Gesture state lives in refs (read synchronously in the pointer handlers, before the next render
    // flushes); the mirroring React state drives what the canvas renders.
    const strokeRef = useRef<FreedrawStroke | null>(null);
    const lineRef = useRef<LineDraft | null>(null);
    const lineMovedRef = useRef(false);
    const eraserRef = useRef<{ marked: Set<string>; last: Point } | null>(null);
    const pointerIdRef = useRef<number | null>(null);
    // The pointerType that started the live draw draft — the touch policy pins the two-finger pinch
    // out while a stylus stroke is in flight (palm rejection wins over the handoff).
    const drawPointerTypeRef = useRef<string | null>(null);
    const seedRef = useRef(0);
    // Ctrl/Cmd held while dragging an arrow endpoint suppresses binding. Tracked live off key
    // events for the EVENT-LESS paths — the point-handle preview/commit callbacks and the pointer-less
    // commitLine finish, which have no pointer event to read the modifier from. The creation drag reads
    // it straight off its pointer event (a stuck ref after a missed keyup can't affect that path).
    const suppressRef = useRef(false);
    // The vertex the user has CLICKED to select over a selected line/arrow's handles (null = none).
    // Drives the filled `.eigen-vertex-handle-selected` dot, and is what Delete/Backspace removes — never
    // the whole element while a point is selected. State, not a ref: the selected dot must re-render.
    const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);
    // The pinned segment (polyline index) the user has clicked to select — Delete on it unpins.
    const [selectedPinIndex, setSelectedPinIndex] = useState<number | null>(null);

    const [activeKind, setActiveKind] = useState<'freedraw' | 'line' | 'eraser' | null>(null);
    // True once a line/arrow draft is collecting clicks (mode 'multi') — drives the finish hint. A
    // press-drag-release line never enters multi, so the hint stays hidden for it.
    const [multiPointDraft, setMultiPointDraft] = useState(false);
    const [previewEl, setPreviewEl] = useState<VectorElement | null>(null);
    const [erasing, setErasing] = useState<Set<string>>(EMPTY_IDS);
    const [pointDraft, setPointDraft] = useState<{ id: string; el: VectorLinearElement | VectorArrowElement } | null>(
        null,
    );
    // The bindable shape a dragged/hovered arrow endpoint currently reaches, plus the pointer that reaches
    // it and whether the arrow is elbow — the canvas rings the shape and draws the side-midpoint snap
    // dots from this. null when nothing reaches.
    const [bindHint, setBindHint] = useState<{ shapeId: string; pointer: Point; elbow: boolean } | null>(null);
    // The last preview frame's elbow bind decision, consumed verbatim on commit so pointer-up is a visual
    // no-op — zero release-time recompute. Null between elbow-endpoint drags.
    const elbowDragRef = useRef<{
        end: 'start' | 'end';
        candidate: string | null;
        fixedPoint: [number, number] | null;
    } | null>(null);
    // Which arrow endpoint is mid-drag (null when idle) — the focus indicator hides that end.
    const [draggedEnd, setDragEnd] = useState<'start' | 'end' | null>(null);
    // Which end's focus point (the aim dot inside a bound shape) is being dragged (null when idle) — its
    // vertex/endpoint handles are suppressed for the drag so a re-orbiting endpoint dot can't mislead.
    const [focusDragEnd, setFocusDragEnd] = useState<'start' | 'end' | null>(null);

    const setBindShape = (shape: VectorBindableElement | undefined, pointer: Point, elbow: boolean) =>
        setBindHint(shape ? { shapeId: shape.id, pointer, elbow } : null);
    // The bindable shape an endpoint at `scene` reaches (null when nothing reaches / binding is suppressed).
    const candidateShape = (scene: Point, suppressed: boolean): VectorBindableElement | undefined =>
        bindingCandidate(ordered, scene, liveZoom(), suppressed) ?? undefined;
    // The elbow dock ratio to store at an endpoint (the point-handle path, event-less → reads suppressRef).
    const elbowBindFor = (
        scene: Point,
    ): { candidate: string | null; fixedPoint: [number, number] | null; shape: VectorBindableElement | undefined } => {
        const shape = candidateShape(scene, suppressRef.current);
        if (!shape) return { candidate: null, fixedPoint: null, shape: undefined };
        return { candidate: shape.id, fixedPoint: elbowBindPoint(shape, scene).fixedPoint, shape };
    };

    useEffect(() => {
        const track = (e: KeyboardEvent) => {
            suppressRef.current = e.ctrlKey || e.metaKey;
        };
        document.addEventListener('keydown', track);
        document.addEventListener('keyup', track);
        return () => {
            document.removeEventListener('keydown', track);
            document.removeEventListener('keyup', track);
        };
    }, []);

    // --- Freehand -------------------------------------------------------------------------------
    const cancelFreedraw = () => {
        strokeRef.current = null;
        pointerIdRef.current = null;
        frozenRef.current = false;
        setActiveKind(null);
        setPreviewEl(null);
    };

    const finishFreedraw = () => {
        const stroke = strokeRef.current;
        cancelFreedraw();
        if (!stroke) return;
        // Real pen pressure iff any sample left the 0.5 no-pressure sentinel (Excalidraw's test — a mouse
        // reports a flat 0.5). normalizeLinear preserves point order and count, so stroke.pressures stays
        // index-aligned with the written points. Simulate ⇒ pressures '' + true ⇒ byte-identical legacy ink.
        const realPressure = stroke.pressures.some((p) => p !== 0.5);
        // Tool stays freedraw (Excalidraw keeps the pencil active); one addElement per stroke.
        const id = sealed(undoManager, () =>
            addElement({
                type: 'freedraw',
                seed: seedRef.current,
                ...normalizeLinear(
                    { x: stroke.origin.x, y: stroke.origin.y, width: 0, height: 0, angle: 0 },
                    stroke.points,
                ),
                pressures: realPressure ? serializePressures(stroke.pressures) : '',
                simulatePressure: !realPressure,
            }),
        );
        if (id) setSelectedIds([id]);
    };

    // --- Line / arrow ---------------------------------------------------------------------------
    const linePreview = (draft: LineDraft) => {
        const pts = previewPoints(draft);
        setPreviewEl(
            draft.type === 'arrow'
                ? arrowElement(draft.origin, pts, seedRef.current)
                : previewElement(draft.type, draft.origin, pts, seedRef.current),
        );
    };

    const clearLine = () => {
        lineRef.current = null;
        lineMovedRef.current = false;
        pointerIdRef.current = null;
        frozenRef.current = false;
        setActiveKind(null);
        setMultiPointDraft(false);
        setPreviewEl(null);
        setBindHint(null);
    };

    // Write the draft as one element. < 2 distinct points is not a line — write nothing. An arrow also
    // resolves both endpoints' bindings and snaps them to their shapes (bindArrow) in the same write.
    const commitLine = (points: Point[]) => {
        const draft = lineRef.current;
        clearLine();
        if (!draft || distinctCount(points) < 2) return;
        const id = sealed(undoManager, () => {
            if (draft.type === 'arrow') {
                const bound = bindArrow(
                    arrowElement(draft.origin, points, seedRef.current),
                    { start: true, end: true },
                    ordered,
                    liveZoom(),
                    suppressRef.current,
                );
                return addElement({ type: 'arrow', seed: seedRef.current, ...bound });
            }
            return addElement({
                type: draft.type,
                seed: seedRef.current,
                ...normalizeLinear({ x: draft.origin.x, y: draft.origin.y, width: 0, height: 0, angle: 0 }, points),
            });
        });
        if (id) setSelectedIds([id]);
    };

    const finishLineWith = (points: Point[]) => {
        commitLine(points);
        // A finished line returns to select (Excalidraw); the pencil is the only tool that always stays,
        // and the tool lock keeps the current tool active for repeated placement.
        if (!toolLocked) setTool('select');
    };

    // A click in multi mode: finish on the last/first point, else commit a new point.
    const addLineClick = (scene: Point, shift: boolean) => {
        const draft = lineRef.current;
        if (!draft) return;
        const rel = { x: scene.x - draft.origin.x, y: scene.y - draft.origin.y };
        const last = draft.committed[draft.committed.length - 1];
        const first = draft.committed[0];
        const confirm = LINE_CONFIRM_SCREEN / liveZoom();
        if (draft.committed.length >= 2 && dist(rel, last) <= confirm) return finishLineWith(draft.committed);
        if (draft.type === 'line' && draft.committed.length >= 3 && dist(rel, first) <= confirm) {
            // Close the loop on the first point so the fill (isClosedPath) reads a closed path.
            return finishLineWith([...draft.committed, { x: 0, y: 0 }]);
        }
        const placed = shift ? snapSegment(last, rel) : rel;
        draft.committed.push(placed);
        draft.trailing = placed;
        linePreview(draft);
    };

    // --- Eraser ---------------------------------------------------------------------------------
    const cancelEraser = () => {
        eraserRef.current = null;
        pointerIdRef.current = null;
        frozenRef.current = false;
        setActiveKind(null);
        setErasing(EMPTY_IDS);
    };

    const finishEraser = () => {
        const er = eraserRef.current;
        cancelEraser();
        if (!er?.marked.size) return;
        sealed(undoManager, () => deleteElements([...er.marked]));
        // Tool stays eraser.
    };

    // --- Pointer dispatch -----------------------------------------------------------------------
    const onPointerDown = (e: React.PointerEvent, scene: Point): boolean => {
        if (!canEdit) return false;
        // Any pointerdown that reaches the surface clears the point selection (clicking the shaft, the
        // canvas, or another element) — vertex/midpoint handles stopPropagation, so a handle click never
        // gets here and keeps its own selection.
        setSelectedPointIndex(null);
        if (tool === 'freedraw') {
            containerRef.current?.setPointerCapture(e.pointerId);
            frozenRef.current = true;
            undoManager?.stopCapturing();
            setSelectedIds([]);
            seedRef.current = randomSeed();
            pointerIdRef.current = e.pointerId;
            drawPointerTypeRef.current = e.pointerType;
            strokeRef.current = startFreedrawStroke(scene, e.pressure);
            setActiveKind('freedraw');
            setPreviewEl(previewElement('freedraw', scene, strokeRef.current.points, seedRef.current));
            return true;
        }
        if (tool === 'eraser') {
            containerRef.current?.setPointerCapture(e.pointerId);
            frozenRef.current = true;
            pointerIdRef.current = e.pointerId;
            drawPointerTypeRef.current = e.pointerType;
            const marked = new Set<string>();
            markErase(
                ordered,
                scene,
                scene,
                hitThresholdScreen(coarse) / liveZoom(),
                ERASER_STEP_SCREEN / liveZoom(),
                e.altKey,
                marked,
                byId,
            );
            eraserRef.current = { marked, last: scene };
            setErasing(new Set(marked));
            setActiveKind('eraser');
            return true;
        }
        if (tool === 'line' || tool === 'arrow') {
            if (lineRef.current) {
                addLineClick(scene, e.shiftKey);
            } else {
                containerRef.current?.setPointerCapture(e.pointerId);
                frozenRef.current = true;
                undoManager?.stopCapturing();
                setSelectedIds([]);
                seedRef.current = randomSeed();
                pointerIdRef.current = e.pointerId;
                drawPointerTypeRef.current = e.pointerType;
                lineMovedRef.current = false;
                lineRef.current = startLineDraft(tool, scene);
                setActiveKind('line');
                linePreview(lineRef.current);
            }
            return true;
        }
        return false;
    };

    const onPointerMove = (e: React.PointerEvent): boolean => {
        if (strokeRef.current) {
            if (pointerIdRef.current !== e.pointerId) return true;
            const native = e.nativeEvent;
            const coalesced = native.getCoalescedEvents?.() ?? [];
            // Each coalesced event carries its own clientX/Y AND pressure; fall back to the plain event when
            // coalescing is unavailable (injected/synthetic events return []). Points and pressures are read
            // from the same source so they stay index-aligned before extendFreedrawStroke's minDist thinning.
            const src = coalesced.length ? coalesced : [native];
            const pts = src.map((ce) => clientToScene(ce.clientX, ce.clientY));
            const pressures = src.map((ce) => ce.pressure);
            extendFreedrawStroke(strokeRef.current, pts, pressures, FREEDRAW_MIN_STEP_SCREEN / liveZoom());
            setPreviewEl(
                previewElement('freedraw', strokeRef.current.origin, strokeRef.current.points, seedRef.current),
            );
            return true;
        }
        if (eraserRef.current) {
            const er = eraserRef.current;
            if (pointerIdRef.current !== e.pointerId) return true;
            const scene = clientToScene(e.clientX, e.clientY);
            const changed = markErase(
                ordered,
                er.last,
                scene,
                hitThresholdScreen(coarse) / liveZoom(),
                ERASER_STEP_SCREEN / liveZoom(),
                e.altKey,
                er.marked,
                byId,
            );
            er.last = scene;
            if (changed) setErasing(new Set(er.marked));
            return true;
        }
        if (lineRef.current) {
            const draft = lineRef.current;
            const scene = clientToScene(e.clientX, e.clientY);
            const rel = { x: scene.x - draft.origin.x, y: scene.y - draft.origin.y };
            const last = draft.committed[draft.committed.length - 1];
            draft.trailing = e.shiftKey ? snapSegment(last, rel) : rel;
            if (draft.mode === 'pending' && dist(scene, draft.origin) >= LINE_DRAG_SCREEN / liveZoom())
                lineMovedRef.current = true;
            // The moving endpoint (origin + trailing) drives the binding highlight for an arrow draft.
            // Read Ctrl/Cmd off the live pointer event here — a keyup missed during a window blur can
            // leave suppressRef stuck, and this path always has the event; the event-less commit paths
            // still read suppressRef.
            if (draft.type === 'arrow') {
                const tip = { x: draft.origin.x + draft.trailing.x, y: draft.origin.y + draft.trailing.y };
                // A creation draft is always straight (the elbow flag is applied later via the panel), so the
                // snap dots read elbow:false; the dock lands on commit through bindArrow.
                setBindShape(candidateShape(tip, e.ctrlKey || e.metaKey), tip, false);
            }
            linePreview(draft);
            return true;
        }
        // Pre-click hover (arrow tool, no draft): ring the bindable shape the cursor reaches so the bind
        // target is visible before the first click. Doesn't consume the move. Ctrl/Cmd suppresses.
        if (tool === 'arrow' && !busy) {
            const scene = clientToScene(e.clientX, e.clientY);
            setBindShape(candidateShape(scene, e.ctrlKey || e.metaKey), scene, false);
        }
        return false;
    };

    // The pointer left the canvas → clear the pre-click hover highlight, but never a live draft's tip
    // candidate (a multi-point draft leaves the surface unfrozen, so the pointer can roam off it).
    const onPointerLeave = () => {
        if (!lineRef.current) setBindHint(null);
    };

    const onPointerUp = (e: React.PointerEvent): boolean => {
        if (strokeRef.current) {
            if (pointerIdRef.current !== e.pointerId) return true;
            finishFreedraw();
            return true;
        }
        if (eraserRef.current) {
            if (pointerIdRef.current !== e.pointerId) return true;
            finishEraser();
            return true;
        }
        if (lineRef.current) {
            const draft = lineRef.current;
            if (pointerIdRef.current !== null && pointerIdRef.current !== e.pointerId) return true;
            if (draft.mode === 'pending') {
                if (lineMovedRef.current) {
                    // A real drag → a 2-point line.
                    finishLineWith([{ x: 0, y: 0 }, draft.trailing]);
                } else {
                    // A click with no drag → switch to a multi-point line whose trailing follows.
                    draft.mode = 'multi';
                    setMultiPointDraft(true);
                    pointerIdRef.current = null;
                    frozenRef.current = false;
                }
            }
            return true;
        }
        return false;
    };

    // A second finger landed mid-draw: hand the surface to a two-finger gesture by ending whatever
    // draw draft is live. A freehand stroke is discarded when it's still a short palm spike, else
    // finalized (Excalidraw App.tsx:8398-8432); an eraser swipe commits what it marked; a press-drag
    // line draft keeps its committed points (mirrors Escape). Returns whether a draft was ended.
    const abortForSecondTouch = (): boolean => {
        if (strokeRef.current) {
            if (isFreedrawSpike(strokeRef.current.points.length)) cancelFreedraw();
            else finishFreedraw();
            return true;
        }
        if (eraserRef.current) {
            finishEraser();
            return true;
        }
        if (lineRef.current) {
            finishLineWith(lineRef.current.committed);
            return true;
        }
        return false;
    };

    // Whether the live draw draft (if any) was started by a stylus — the touch policy pins the
    // two-finger pinch out while a pen stroke is in flight, so palm rejection wins over the handoff.
    const isPenDrawing = (): boolean =>
        drawPointerTypeRef.current === 'pen' &&
        (strokeRef.current !== null || eraserRef.current !== null || lineRef.current !== null);

    // --- Point handles (a single selected line or arrow) ----------------------------------------
    const sole = selectedIds.length === 1 ? ordered.find((el) => el.id === selectedIds[0]) : undefined;
    // Lines and arrows get vertex handles; freedraw never does.
    const selectedLine =
        !busy && !activeKind && canEdit && (sole?.type === 'line' || sole?.type === 'arrow') ? sole : undefined;
    const isEndpoint = (index: number, count: number) => index === 0 || index === count - 1;

    // If the selected line/arrow vanishes mid vertex-drag — a remote delete unmounts LinePointHandles
    // before its pointerup — its preview element and binding highlight would otherwise linger. Drop them
    // the moment the selection stops resolving to a line/arrow (also a plain deselect: harmless there).
    const selectedLineId = selectedLine?.id;
    const selectedPointCount = selectedLine ? parsePoints(selectedLine.points).length : 0;
    useEffect(() => {
        if (!selectedLineId) {
            setPointDraft(null);
            setBindHint(null);
            elbowDragRef.current = null;
            setDragEnd(null);
            setFocusDragEnd(null);
            setSelectedPinIndex(null);
        }
        // Drop any point selection that no longer resolves: the element deselected/changed, or a remote
        // peer shrank its point count below the selected index — leaving the filled dot gone while Delete
        // stayed a consumed no-op. Keep an in-range index untouched; the updater skips a no-op set.
        setSelectedPointIndex((i) => (i !== null && i < selectedPointCount ? i : null));
    }, [selectedLineId, selectedPointCount]);

    const onPointPreview = (points: Point[] | null, index: number) => {
        if (!points || !selectedLine) {
            setPointDraft(null);
            setBindHint(null);
            elbowDragRef.current = null;
            setDragEnd(null);
            return;
        }
        if (
            selectedLine.type === 'arrow' &&
            selectedLine.elbow &&
            selectedLine.fixedSegments !== '' &&
            isEndpoint(index, points.length)
        ) {
            // A PINNED elbow endpoint drag: keep the interior polyline + every pin verbatim, re-drop
            // only this end's connector (moveEndpoints) — but thread the dock like the unpinned branch, so a
            // bound end attaches at its outline dock at release instead of hanging on the raw cursor until the
            // shape next moves. The decision is cached for the commit to replay verbatim.
            const arrow = selectedLine;
            const end = index === 0 ? 'start' : 'end';
            const endScene = linearLocalToScene(arrow, points[index]);
            const { candidate, fixedPoint, shape } = elbowBindFor(endScene);
            elbowDragRef.current = { end, candidate, fixedPoint };
            setDragEnd(end);
            setPointDraft({
                id: arrow.id,
                el: { ...arrow, ...bindPinnedElbowEnd(arrow, end, candidate, fixedPoint, endScene, byId) },
            });
            setBindShape(shape, endScene, true);
            return;
        }
        if (selectedLine.type === 'arrow' && isEndpoint(index, points.length)) {
            const arrow = selectedLine;
            const end = index === 0 ? 'start' : 'end';
            const reshaped = { ...arrow, ...normalizeLinear(arrow, points) };
            setDragEnd(end);
            const endScene = linearLocalToScene(arrow, points[index]);
            if (arrow.elbow) {
                // The endpoint glides on the outline dock: the preview element carries the DOCKED
                // endpoint and the live candidate as its binding — post-commit form — so its derived route
                // (elbowRoute off this element) is exactly what release stores. The
                // decision is cached for the commit to replay verbatim (zero release-time recompute).
                const { candidate, fixedPoint, shape } = elbowBindFor(endScene);
                elbowDragRef.current = { end, candidate, fixedPoint };
                const bound = bindElbowEnd(reshaped, end, candidate, fixedPoint, byId);
                setPointDraft({ id: arrow.id, el: { ...reshaped, ...bound } });
                setBindShape(shape, endScene, true);
            } else {
                // Straight: the dragged end follows the raw cursor (docked on release via bindArrow); the
                // OTHER bound end re-orbits live so it too matches post-release.
                elbowDragRef.current = null;
                const followed = followOtherEnd(reshaped, end, byId);
                setPointDraft({ id: arrow.id, el: { ...reshaped, ...followed } });
                setBindShape(candidateShape(endScene, suppressRef.current), endScene, false);
            }
            return;
        }
        // A line, or a middle vertex of an arrow — a plain reshape, no binding.
        elbowDragRef.current = null;
        setDragEnd(null);
        setPointDraft({ id: selectedLine.id, el: { ...selectedLine, ...normalizeLinear(selectedLine, points) } });
        setBindHint(null);
    };

    const onPointCommit = (points: Point[], index: number) => {
        setBindHint(null);
        const cached = elbowDragRef.current;
        elbowDragRef.current = null;
        setDragEnd(null);
        if (!selectedLine) {
            setPointDraft(null);
            return;
        }
        sealed(undoManager, () => {
            if (
                selectedLine.type === 'arrow' &&
                selectedLine.elbow &&
                selectedLine.fixedSegments !== '' &&
                isEndpoint(index, points.length)
            ) {
                // Pinned elbow endpoint commit: thread the dock (bindPinnedElbowEnd, replaying the cached
                // preview frame so release === last frame) then the renormalization pass, one sealed write. When
                // the endpoint collapses back to derived (fixedSegments ''), skip the renormalize wrap so the
                // canonical origin survives; the binding fields ride through either way.
                const arrow = selectedLine;
                const end = index === 0 ? 'start' : 'end';
                const endScene = linearLocalToScene(arrow, points[index]);
                const frame = cached && cached.end === end ? cached : elbowBindFor(endScene);
                const bound = bindPinnedElbowEnd(arrow, end, frame.candidate, frame.fixedPoint, endScene, byId);
                updateElement(
                    arrow.id,
                    bound.fixedSegments === ''
                        ? bound
                        : {
                              ...renormalize({ ...arrow, ...bound }),
                              startBinding: bound.startBinding,
                              endBinding: bound.endBinding,
                          },
                );
            } else if (selectedLine.type === 'arrow') {
                const reshaped = { ...selectedLine, ...normalizeLinear(selectedLine, points) };
                if (selectedLine.elbow && isEndpoint(index, points.length)) {
                    // Replay the last preview frame's cached dock — never re-run the candidate search from the
                    // release cursor. Recompute only in the degenerate no-move case (no preview frame ran).
                    const end = index === 0 ? 'start' : 'end';
                    const frame =
                        cached && cached.end === end
                            ? cached
                            : elbowBindFor(linearLocalToScene(selectedLine, points[index]));
                    updateElement(
                        selectedLine.id,
                        bindElbowEnd(reshaped, end, frame.candidate, frame.fixedPoint, byId),
                    );
                } else {
                    // Straight (or a middle vertex): the dragged endpoint (re)binds/unbinds via the chord model,
                    // the other end keeps its binding, every bound end re-snaps through bindArrow.
                    const bound = bindArrow(
                        reshaped,
                        { start: index === 0, end: index === points.length - 1 },
                        ordered,
                        liveZoom(),
                        suppressRef.current,
                    );
                    updateElement(selectedLine.id, bound);
                }
            } else {
                updateElement(selectedLine.id, normalizeLinear(selectedLine, points));
            }
        });
        setPointDraft(null);
    };

    // Elbow segment-pin preview/commit. A pin drag returns a full geometry PATCH (points +
    // fixedSegments + box); the preview mounts it on a draft element (arrowRoute reads its stored polyline
    // verbatim), and the commit runs the renormalization pass so the sealed write === the last preview
    // frame for a clean drag. Materialize/moveSegment/unpin all flow through here.
    const onElbowPinPreview = (patch: PinPatch | null) => {
        if (patch === null || selectedLine?.type !== 'arrow') {
            setPointDraft(null);
            return;
        }
        setPointDraft({ id: selectedLine.id, el: { ...selectedLine, ...patch } });
    };
    const onElbowPinCommit = (patch: PinPatch) => {
        if (selectedLine?.type !== 'arrow') return;
        // Unpinning the last pin returns the arrow to derived mode with a canonical origin — skip the
        // renormalize wrap there, which would re-run it over a now-derived 2-point arrow.
        sealed(undoManager, () =>
            updateElement(
                selectedLine.id,
                patch.fixedSegments === '' ? patch : renormalize({ ...selectedLine, ...patch }),
            ),
        );
        setSelectedPinIndex(null);
        setPointDraft(null);
    };

    // Focus-point (aim dot) drag preview/commit. The preview re-binds the dragged end to the live aim
    // and re-derives its chord endpoint on a draft element, so the drawn arrow + the dashed line + the dots
    // all track; `focusDragEnd` hides the vertex handles for the drag. The commit stores the RAW dragged aim
    // (no re-projection — Excalidraw's handleFocusPointDrag) as one sealed write.
    const onFocusPreview = (end: 'start' | 'end', fixedPoint: [number, number] | null, pointer?: Point) => {
        if (fixedPoint === null || selectedLine?.type !== 'arrow') {
            setPointDraft(null);
            setFocusDragEnd(null);
            setBindHint(null);
            return;
        }
        const binding = parseBinding(end === 'start' ? selectedLine.startBinding : selectedLine.endBinding);
        if (!binding) return;
        setFocusDragEnd(end);
        setPointDraft({
            id: selectedLine.id,
            el: { ...selectedLine, ...bindFocusPoint(selectedLine, end, binding.elementId, fixedPoint, byId) },
        });
        // Eigen extension: light the shape's snap dots at the live aim so the magnet is visible.
        const shape = ordered.find((el) => el.id === binding.elementId);
        if (pointer && shape && isBindable(shape)) setBindShape(shape, pointer, false);
        else setBindHint(null);
    };
    const onFocusCommit = (end: 'start' | 'end', fixedPoint: [number, number]) => {
        setFocusDragEnd(null);
        setBindHint(null);
        if (selectedLine?.type !== 'arrow') {
            setPointDraft(null);
            return;
        }
        const binding = parseBinding(end === 'start' ? selectedLine.startBinding : selectedLine.endBinding);
        if (binding) {
            sealed(undoManager, () =>
                updateElement(selectedLine.id, bindFocusPoint(selectedLine, end, binding.elementId, fixedPoint, byId)),
            );
        }
        setPointDraft(null);
    };

    // The elbow arrow whose route the pin dots sit on: the live preview draft while a pin drags (so the
    // dots track the re-routing snake), else the committed selection.
    const elbowForPins =
        selectedLine?.type === 'arrow' && selectedLine.elbow
            ? pointDraft?.el.type === 'arrow' && pointDraft.el.id === selectedLine.id && pointDraft.el.elbow
                ? pointDraft.el
                : selectedLine
            : null;

    // The arrow the focus affordances read: the live preview draft (so a focus/endpoint drag re-aims the
    // dashed line + dots) else the committed selection.
    const focusArrow =
        pointDraft?.el.type === 'arrow' ? pointDraft.el : selectedLine?.type === 'arrow' ? selectedLine : null;

    // A focus-point drag suppresses the vertex handles (a re-orbiting endpoint dot would detach from the
    // shaft mid-drag); every other time they show for a selected line/arrow.
    const linePointHandles =
        selectedLine && !focusDragEnd
            ? createElement(LinePointHandles, {
                  line: selectedLine,
                  zoom,
                  boxToStyle,
                  clientToScene,
                  frozenRef,
                  onPreview: onPointPreview,
                  onCommit: onPointCommit,
                  selectedIndex: selectedPointIndex,
                  onSelect: setSelectedPointIndex,
              })
            : null;

    // The draggable aim dots over a selected bound straight arrow's focus points — a DOM overlay, so its
    // pointerdown claims the gesture before the canvas hit-test. Hidden during an endpoint/pin drag
    // (`draggedEnd`) and while a non-select tool is active.
    const focusPointHandles =
        focusArrow && !focusArrow.elbow && !activeKind && !draggedEnd
            ? createElement(FocusPointHandles, {
                  key: 'focus-handles',
                  arrow: focusArrow,
                  byId,
                  zoom,
                  hideEnd: null,
                  boxToStyle,
                  clientToScene,
                  frozenRef,
                  onPreview: onFocusPreview,
                  onCommit: onFocusCommit,
              })
            : null;

    // Endpoint dots (every line/arrow) plus, for an elbow arrow, the segment-pin dots on its derived route.
    const elbowPinHandles = elbowForPins
        ? createElement(ElbowPinHandles, {
              key: 'elbow-pins',
              arrow: elbowForPins,
              route: arrowRoute(elbowForPins, byId) ?? [],
              context: elbowRoutingContext(elbowForPins, byId),
              zoom,
              boxToStyle,
              clientToScene,
              frozenRef,
              onPreview: onElbowPinPreview,
              onCommit: onElbowPinCommit,
              selectedPinIndex,
              onSelectPin: setSelectedPinIndex,
          })
        : null;
    const handles =
        linePointHandles || elbowPinHandles || focusPointHandles
            ? createElement(Fragment, null, linePointHandles, elbowPinHandles, focusPointHandles)
            : null;

    // The shape-following outline over the shape a dragged/hovered arrow endpoint reaches (creation, a
    // point-handle drag, or the pre-click hover). An SVG `<g>` for the scene group: the kind's own outline
    // stroked in the selection colour (`currentColor`, tinted by the `text-selection-handle` group), so no
    // shape math is duplicated here.
    const candidate = bindHint ? ordered.find((el) => el.id === bindHint.shapeId) : undefined;
    const bindingOutline =
        candidate && isBindable(candidate)
            ? createElement('g', {
                  className: 'text-selection-handle',
                  dangerouslySetInnerHTML: { __html: bindingOutlineSvg(candidate, zoom) },
              })
            : null;

    // Side-midpoint snap dots over the reached shape — the visual face of snapToMid, so the dock lands
    // on the highlighted dot. Scene-group SVG, drawn next to the outline.
    const snapDots =
        bindHint && candidate && isBindable(candidate)
            ? createElement(SnapDots, { shape: candidate, pointer: bindHint.pointer, zoom, elbow: bindHint.elbow })
            : null;

    // The straight-arrow focus point: shown for a single selected bound arrow, and during its
    // endpoint drag for the OTHER end (the dragged end is hidden). Reads the live preview element while
    // dragging so the un-dragged end reflects its re-orbit / its aim.
    const focusIndicators =
        focusArrow && !focusArrow.elbow && !activeKind
            ? createElement(FocusIndicators, { arrow: focusArrow, byId, zoom, hideEnd: draggedEnd })
            : null;

    // --- Escape / Enter / double-click / blur (capture phase, latest closures via a ref) ----------
    const api = {
        escape: (): boolean => {
            if (strokeRef.current) {
                cancelFreedraw();
                return true;
            }
            if (eraserRef.current) {
                cancelEraser();
                return true;
            }
            if (lineRef.current) {
                // Escape keeps the committed points, dropping the trailing one.
                finishLineWith(lineRef.current.committed);
                return true;
            }
            // Layered Escape: a selected point releases BEFORE the element does. Clear it here (capture
            // phase, so `stopPropagation` beats the canvas's bubble-phase element-deselect) and consume;
            // with no point selected we fall through and the canvas deselects the element as usual.
            if (selectedPointIndex !== null) {
                setSelectedPointIndex(null);
                return true;
            }
            if (selectedPinIndex !== null) {
                setSelectedPinIndex(null);
                return true;
            }
            return false;
        },
        finish: (): boolean => {
            if (!lineRef.current) return false;
            finishLineWith(lineRef.current.committed);
            return true;
        },
        // Delete/Backspace with a point SELECTED acts on THAT point, never the whole element. An
        // interior point is removed (one sealed step, winning over the keyboard hook's delete-selection).
        // A selected ENDPOINT (index 0/last, where an arrow's bindings ride) or any point of an elbow
        // arrow (route derived, no editable interior) is a no-op — but we STILL consume the key so it
        // cannot fall through and delete the element out from under a selected point. With no point
        // selected we return false and selection-delete removes the whole element as usual.
        deleteSelectedPoint: (): boolean => {
            // A selected PIN unpins — precedence over vertex/element delete, one sealed step.
            if (
                selectedPinIndex !== null &&
                selectedLine?.type === 'arrow' &&
                selectedLine.elbow &&
                selectedLine.fixedSegments !== ''
            ) {
                // Dropping the last pin returns to derived mode with a canonical origin — skip the
                // renormalize wrap there so that origin survives.
                const patch = unpinSegment(selectedLine, selectedPinIndex);
                sealed(undoManager, () =>
                    updateElement(
                        selectedLine.id,
                        patch.fixedSegments === '' ? patch : renormalize({ ...selectedLine, ...patch }),
                    ),
                );
                setSelectedPinIndex(null);
                return true;
            }
            const index = selectedPointIndex;
            if (index === null || !selectedLine) return false;
            const pts = parsePoints(selectedLine.points);
            const interior =
                !(selectedLine.type === 'arrow' && selectedLine.elbow) && index > 0 && index < pts.length - 1;
            if (!interior) return true; // endpoint / elbow → no-op, but consume (never delete the element)
            sealed(undoManager, () =>
                updateElement(
                    selectedLine.id,
                    normalizeLinear(
                        selectedLine,
                        pts.filter((_, i) => i !== index),
                    ),
                ),
            );
            // After removing an interior point, keep editing the previous point IF it is still interior
            // (i.e. the removed one wasn't the first interior point); otherwise clear the point selection.
            // Points before the removed index keep their index, so `index - 1` still addresses that point.
            setSelectedPointIndex(index >= 2 ? index - 1 : null);
            return true;
        },
        // Focus loss can swallow the pointerup (alt-tab mid-gesture) — commit like ObjectTransform does
        // so no gesture is left tracking a released pointer / a preview stuck on screen.
        blur: () => {
            if (strokeRef.current) finishFreedraw();
            else if (eraserRef.current) finishEraser();
            else if (lineRef.current) finishLineWith(lineRef.current.committed);
        },
    };
    const apiRef = useRef(api);
    apiRef.current = api;

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (isTypingTarget()) return;
            if (e.key === 'Escape') {
                if (apiRef.current.escape()) {
                    e.preventDefault();
                    e.stopPropagation();
                }
                return;
            }
            if (e.key === 'Enter' && apiRef.current.finish()) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            // A SELECTED point claims Delete/Backspace before the keyboard hook's delete-selection (which
            // binds on document in the bubble phase) — stopping propagation here keeps that from also
            // firing, so the element is never deleted while a point is selected. Falls through only when no
            // point is selected, and then selection-delete removes the whole element normally.
            if ((e.key === 'Delete' || e.key === 'Backspace') && apiRef.current.deleteSelectedPoint()) {
                e.preventDefault();
                e.stopPropagation();
            }
        };
        const onDbl = () => apiRef.current.finish();
        const onBlur = () => apiRef.current.blur();
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('dblclick', onDbl);
        window.addEventListener('blur', onBlur);
        return () => {
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('dblclick', onDbl);
            window.removeEventListener('blur', onBlur);
        };
    }, []);

    // Switching tools abandons an in-progress stroke/erase, but commits a polyline/arrow's placed points
    // (Excalidraw finalizes rather than strands it). A draft is committed once the tool no longer matches
    // its own type, so line↔arrow switches never leave a draft the other tool would keep appending to.
    // Via a ref so the effect only depends on `tool`.
    const abandonRef = useRef<() => void>(() => {});
    abandonRef.current = () => {
        if (tool !== 'freedraw' && strokeRef.current) cancelFreedraw();
        if (lineRef.current && lineRef.current.type !== tool) commitLine(lineRef.current.committed);
        if (tool !== 'eraser' && eraserRef.current) cancelEraser();
        // Leaving the arrow tool drops any lingering pre-click hover highlight (no draft in flight).
        if (tool !== 'arrow' && !lineRef.current) setBindHint(null);
    };
    useEffect(() => {
        abandonRef.current();
    }, [tool]);

    return {
        active: activeKind !== null,
        multiPointDraft,
        previewElement: pointDraft?.el ?? previewEl,
        hiddenId: pointDraft?.id ?? null,
        erasingIds: erasing,
        handles,
        bindingOutline,
        snapDots,
        focusIndicators,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        abortForSecondTouch,
        isPenDrawing,
        onPointerLeave,
    };
}
