// The drawing tools (freehand, line, eraser) + line point-handles, factored out of vector-canvas.tsx
// so the canvas only DISPATCHES (R2.10–R2.14, the ground-rule that the canvas file must not grow).
// This hook owns the local gesture state (never Yjs until finish), the live preview element rendered
// through the SAME elementToSvg path as committed elements, the eraser's marked-set dimming, and the
// single sealed write per gesture. Escape/Enter/double-click are claimed in the capture phase so the
// innermost active gesture wins over the canvas' layered-Escape (CANVAS.md), exactly as ObjectTransform
// claims Escape mid-resize.

import {
    type Box,
    DEFAULT_ARROW_PROPS,
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_LINEAR_ROUNDNESS,
    DEFAULT_TEXT_PROPS,
    elbowBindPoint,
    elementToSvg,
    isBindable,
    linearLocalToScene,
    normalizeLinear,
    type Point,
    parsePoints,
    type VectorArrowElement,
    type VectorElement,
    type VectorLinearElement,
    type VectorShapeElement,
} from '@workspace/lib/vector';
import { createElement, type MutableRefObject, type ReactNode, useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { isTypingTarget } from '../../../hooks/is-typing-target';
import type { VectorTool } from '../hooks/use-tool';
import type { NewVectorElement, VectorElementPatch } from '../hooks/use-vector-doc';
import { FocusIndicators, SnapDots } from './arrow-affordances';
import { bindArrow, bindElbowEnd, bindingCandidate, bindingOutlineElement, followOtherEnd } from './binding';
import { markErase } from './eraser';
import { extendFreedrawStroke, type FreedrawStroke, startFreedrawStroke } from './freedraw';
import { distinctCount, type LineDraft, previewPoints, snapSegment, startLineDraft } from './line';
import { LinePointHandles } from './point-handles';

// Screen-px thresholds (÷ zoom → constant on-screen distance): hit tolerance and eraser sample step
// (Excalidraw's DEFAULT_COLLISION_THRESHOLD / eraser trail), the freehand minimum sample spacing that
// thins sub-pixel points, the multi-point line's confirm/close radius (LINE_CONFIRM_THRESHOLD), and the
// drag-vs-click threshold that splits a 2-point line from a multi-point one.
const HIT_THRESHOLD_SCREEN = 8;
const ERASER_STEP_SCREEN = 4;
const FREEDRAW_MIN_STEP_SCREEN = 1;
const LINE_CONFIRM_SCREEN = 8;
const LINE_DRAG_SCREEN = 4;

const PREVIEW_ID = '__drawing__';
const EMPTY_IDS: Set<string> = new Set();

function randomSeed(): number {
    return Math.floor(Math.random() * 2 ** 31);
}

function dist(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

// The shared geometry of a live preview element (draw draft), built from the create defaults and the
// same normalizeLinear pass as the commit, so it matches the element that will be written exactly (the
// renderer scales roughness by the box, so a 0×0 box would pop on release).
function linearBase(origin: Point, points: Point[], seed: number) {
    return {
        id: PREVIEW_ID,
        angle: 0,
        ...DEFAULT_ELEMENT_PROPS,
        roundness: DEFAULT_LINEAR_ROUNDNESS,
        seed,
        index: 'a0',
        ...normalizeLinear({ x: origin.x, y: origin.y, width: 0, height: 0, angle: 0 }, points),
    };
}

function previewElement(type: 'freedraw' | 'line', origin: Point, points: Point[], seed: number): VectorLinearElement {
    return { ...linearBase(origin, points, seed), type };
}

// An arrow preview/commit template — the line geometry plus the default heads and an empty binding/label
// (a draft binds only at commit through bindArrow). Reused as the provisional element bindArrow snaps.
function arrowElement(origin: Point, points: Point[], seed: number): VectorArrowElement {
    return {
        ...linearBase(origin, points, seed),
        type: 'arrow',
        ...DEFAULT_ARROW_PROPS,
        // The label fields the reader reaches out of DEFAULT_TEXT_PROPS (never its textAlign, which the
        // arrow model has no field for) — so the provisional can't drift from read-vector's defaults.
        text: DEFAULT_TEXT_PROPS.text,
        fontSize: DEFAULT_TEXT_PROPS.fontSize,
        fontFamily: DEFAULT_TEXT_PROPS.fontFamily,
    };
}

type DrawingToolsParams = {
    tool: VectorTool;
    setTool: (t: VectorTool) => void;
    // When the tool lock is on, a finished line/arrow keeps its tool active (freedraw/eraser always do).
    toolLocked: boolean;
    canWrite: boolean;
    zoom: number;
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

export type DrawingTools = {
    // A freehand/line/eraser gesture is in flight (chrome is suppressed for it, like create/marquee).
    active: boolean;
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
    // Side-midpoint snap dots over the reached shape (B2), and the straight-arrow focus point (B4/D5) — both
    // SVG for the scene group, drawn next to the outline (null otherwise).
    snapDots: ReactNode;
    focusIndicators: ReactNode;
    onPointerDown: (e: React.PointerEvent, scene: Point) => boolean;
    onPointerMove: (e: React.PointerEvent) => boolean;
    onPointerUp: (e: React.PointerEvent) => boolean;
    // The pointer left the canvas → drop the pre-click hover highlight (no active draft).
    onPointerLeave: () => void;
};

export function useDrawingTools(params: DrawingToolsParams): DrawingTools {
    const {
        tool,
        setTool,
        toolLocked,
        canWrite,
        zoom,
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

    // Gesture state lives in refs (read synchronously in the pointer handlers, before the next render
    // flushes); the mirroring React state drives what the canvas renders.
    const strokeRef = useRef<FreedrawStroke | null>(null);
    const lineRef = useRef<LineDraft | null>(null);
    const lineMovedRef = useRef(false);
    const eraserRef = useRef<{ marked: Set<string>; last: Point } | null>(null);
    const pointerIdRef = useRef<number | null>(null);
    const seedRef = useRef(0);
    // Ctrl/Cmd held while dragging an arrow endpoint suppresses binding (R3.8). Tracked live off key
    // events for the EVENT-LESS paths — the point-handle preview/commit callbacks and the pointer-less
    // commitLine finish, which have no pointer event to read the modifier from. The creation drag reads
    // it straight off its pointer event (a stuck ref after a missed keyup can't affect that path).
    const suppressRef = useRef(false);
    // The vertex the user has CLICKED to select over a selected line/arrow's handles (null = none; EP-PT).
    // Drives the filled `.eigen-vertex-handle-selected` dot, and is what Delete/Backspace removes — never
    // the whole element while a point is selected. State, not a ref: the selected dot must re-render.
    const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);

    const [activeKind, setActiveKind] = useState<'freedraw' | 'line' | 'eraser' | null>(null);
    const [previewEl, setPreviewEl] = useState<VectorElement | null>(null);
    const [erasing, setErasing] = useState<Set<string>>(EMPTY_IDS);
    const [pointDraft, setPointDraft] = useState<{ id: string; el: VectorLinearElement | VectorArrowElement } | null>(
        null,
    );
    // The bindable shape a dragged/hovered arrow endpoint currently reaches, plus the pointer that reaches
    // it and whether the arrow is elbow — the canvas rings the shape (R3.8) and draws the side-midpoint snap
    // dots (B2) from this. null when nothing reaches.
    const [bindHint, setBindHint] = useState<{ shapeId: string; pointer: Point; elbow: boolean } | null>(null);
    // The last preview frame's elbow bind decision, consumed verbatim on commit so pointer-up is a visual
    // no-op — zero release-time recompute (D3/D4). Null between elbow-endpoint drags.
    const elbowDragRef = useRef<{
        end: 'start' | 'end';
        candidate: string | null;
        fixedPoint: [number, number] | null;
    } | null>(null);
    // Which arrow endpoint is mid-drag (null when idle) — the focus indicator hides that end (B4).
    const [draggedEnd, setDragEnd] = useState<'start' | 'end' | null>(null);

    const setBindShape = (shape: VectorShapeElement | undefined, pointer: Point, elbow: boolean) =>
        setBindHint(shape ? { shapeId: shape.id, pointer, elbow } : null);
    // The bindable shape an endpoint at `scene` reaches (null when nothing reaches / binding is suppressed).
    const candidateShape = (scene: Point, suppressed: boolean): VectorShapeElement | undefined => {
        const id = bindingCandidate(ordered, scene, zoom, suppressed);
        const shape = id ? ordered.find((el) => el.id === id) : undefined;
        return shape && isBindable(shape) ? shape : undefined;
    };
    // The elbow dock ratio to store at an endpoint (the point-handle path, event-less → reads suppressRef).
    const elbowBindFor = (
        scene: Point,
    ): { candidate: string | null; fixedPoint: [number, number] | null; shape: VectorShapeElement | undefined } => {
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
        undoManager?.stopCapturing();
        // Tool stays freedraw (Excalidraw keeps the pencil active); one addElement per stroke.
        const id = addElement({
            type: 'freedraw',
            seed: seedRef.current,
            ...normalizeLinear(
                { x: stroke.origin.x, y: stroke.origin.y, width: 0, height: 0, angle: 0 },
                stroke.points,
            ),
        });
        undoManager?.stopCapturing();
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
        setPreviewEl(null);
        setBindHint(null);
    };

    // Write the draft as one element. < 2 distinct points is not a line — write nothing. An arrow also
    // resolves both endpoints' bindings and snaps them to their shapes (bindArrow) in the same write.
    const commitLine = (points: Point[]) => {
        const draft = lineRef.current;
        clearLine();
        if (!draft || distinctCount(points) < 2) return;
        undoManager?.stopCapturing();
        let id: string | undefined;
        if (draft.type === 'arrow') {
            const bound = bindArrow(
                arrowElement(draft.origin, points, seedRef.current),
                { start: true, end: true },
                ordered,
                zoom,
                suppressRef.current,
            );
            id = addElement({ type: 'arrow', seed: seedRef.current, ...bound });
        } else {
            id = addElement({
                type: draft.type,
                seed: seedRef.current,
                ...normalizeLinear({ x: draft.origin.x, y: draft.origin.y, width: 0, height: 0, angle: 0 }, points),
            });
        }
        undoManager?.stopCapturing();
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
        const confirm = LINE_CONFIRM_SCREEN / zoom;
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
        undoManager?.stopCapturing();
        deleteElements([...er.marked]);
        undoManager?.stopCapturing();
        // Tool stays eraser.
    };

    // --- Pointer dispatch -----------------------------------------------------------------------
    const onPointerDown = (e: React.PointerEvent, scene: Point): boolean => {
        if (!canWrite) return false;
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
            strokeRef.current = startFreedrawStroke(scene);
            setActiveKind('freedraw');
            setPreviewEl(previewElement('freedraw', scene, strokeRef.current.points, seedRef.current));
            return true;
        }
        if (tool === 'eraser') {
            containerRef.current?.setPointerCapture(e.pointerId);
            frozenRef.current = true;
            pointerIdRef.current = e.pointerId;
            const marked = new Set<string>();
            markErase(
                ordered,
                scene,
                scene,
                HIT_THRESHOLD_SCREEN / zoom,
                ERASER_STEP_SCREEN / zoom,
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
            const pts = coalesced.length
                ? coalesced.map((ce) => clientToScene(ce.clientX, ce.clientY))
                : [clientToScene(e.clientX, e.clientY)];
            extendFreedrawStroke(strokeRef.current, pts, FREEDRAW_MIN_STEP_SCREEN / zoom);
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
                HIT_THRESHOLD_SCREEN / zoom,
                ERASER_STEP_SCREEN / zoom,
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
            if (draft.mode === 'pending' && dist(scene, draft.origin) >= LINE_DRAG_SCREEN / zoom)
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
        // target is visible before the first click (R3.8). Doesn't consume the move. Ctrl/Cmd suppresses.
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
                    pointerIdRef.current = null;
                    frozenRef.current = false;
                }
            }
            return true;
        }
        return false;
    };

    // --- Point handles (a single selected line or arrow) ----------------------------------------
    const sole = selectedIds.length === 1 ? ordered.find((el) => el.id === selectedIds[0]) : undefined;
    // Lines and arrows get vertex handles; freedraw never does (R2.13).
    const selectedLine =
        !busy && !activeKind && canWrite && (sole?.type === 'line' || sole?.type === 'arrow') ? sole : undefined;
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
        if (selectedLine.type === 'arrow' && isEndpoint(index, points.length)) {
            const arrow = selectedLine;
            const end = index === 0 ? 'start' : 'end';
            const reshaped = { ...arrow, ...normalizeLinear(arrow, points) };
            setDragEnd(end);
            const endScene = linearLocalToScene(arrow, points[index]);
            if (arrow.elbow) {
                // The endpoint glides on the outline dock (E14/B1): the preview element carries the DOCKED
                // endpoint and the live candidate as its binding — post-commit form — so its derived route
                // (elbowRoute off this element) is exactly what release stores (acceptance criterion #1). The
                // decision is cached for the commit to replay verbatim (D3/D4, zero release-time recompute).
                const { candidate, fixedPoint, shape } = elbowBindFor(endScene);
                elbowDragRef.current = { end, candidate, fixedPoint };
                const bound = bindElbowEnd(reshaped, end, candidate, fixedPoint, byId);
                setPointDraft({ id: arrow.id, el: { ...reshaped, ...bound } });
                setBindShape(shape, endScene, true);
            } else {
                // Straight: the dragged end follows the raw cursor (docked on release via bindArrow, B7); the
                // OTHER bound end re-orbits live so it too matches post-release (D7).
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
        undoManager?.stopCapturing();
        if (selectedLine.type === 'arrow') {
            const reshaped = { ...selectedLine, ...normalizeLinear(selectedLine, points) };
            if (selectedLine.elbow && isEndpoint(index, points.length)) {
                // Replay the last preview frame's cached dock — never re-run the candidate search from the
                // release cursor (D4). Recompute only in the degenerate no-move case (no preview frame ran).
                const end = index === 0 ? 'start' : 'end';
                const frame =
                    cached && cached.end === end
                        ? cached
                        : elbowBindFor(linearLocalToScene(selectedLine, points[index]));
                updateElement(selectedLine.id, bindElbowEnd(reshaped, end, frame.candidate, frame.fixedPoint, byId));
            } else {
                // Straight (or a middle vertex): the dragged endpoint (re)binds/unbinds via the chord model,
                // the other end keeps its binding, every bound end re-snaps through bindArrow (R3.10).
                const bound = bindArrow(
                    reshaped,
                    { start: index === 0, end: index === points.length - 1 },
                    ordered,
                    zoom,
                    suppressRef.current,
                );
                updateElement(selectedLine.id, bound);
            }
        } else {
            updateElement(selectedLine.id, normalizeLinear(selectedLine, points));
        }
        undoManager?.stopCapturing();
        setPointDraft(null);
    };

    const handles = selectedLine
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

    // The shape-following outline over the shape a dragged/hovered arrow endpoint reaches (creation, a
    // point-handle drag, or the pre-click hover). An SVG `<g>` for the scene group: `elementToSvg`
    // re-strokes the shape's own geometry in the selection colour (`currentColor`, tinted by the
    // `text-selection-handle` group), so no shape math is duplicated here.
    const candidate = bindHint ? ordered.find((el) => el.id === bindHint.shapeId) : undefined;
    const bindingOutline =
        candidate && isBindable(candidate)
            ? createElement('g', {
                  className: 'text-selection-handle',
                  dangerouslySetInnerHTML: { __html: elementToSvg(bindingOutlineElement(candidate, zoom)) },
              })
            : null;

    // Side-midpoint snap dots over the reached shape (B2) — the visual face of snapToMid, so the dock lands
    // on the highlighted dot. Scene-group SVG, drawn next to the outline.
    const snapDots =
        bindHint && candidate && isBindable(candidate)
            ? createElement(SnapDots, { shape: candidate, pointer: bindHint.pointer, zoom, elbow: bindHint.elbow })
            : null;

    // The straight-arrow focus point (B4/D5): shown for a single selected bound arrow, and during its
    // endpoint drag for the OTHER end (the dragged end is hidden). Reads the live preview element while
    // dragging so the un-dragged end reflects its re-orbit (D7).
    const focusArrow =
        pointDraft?.el.type === 'arrow' ? pointDraft.el : selectedLine?.type === 'arrow' ? selectedLine : null;
    const focusIndicators =
        focusArrow && !focusArrow.elbow && !activeKind
            ? createElement(FocusIndicators, { arrow: focusArrow, byId, zoom, hideEnd: draggedEnd })
            : null;

    // --- Escape / Enter / double-click / blur (capture phase, latest closures via a ref) ----------
    const apiRef = useRef<{
        escape: () => boolean;
        finish: () => boolean;
        deleteSelectedPoint: () => boolean;
        blur: () => void;
    }>({
        escape: () => false,
        finish: () => false,
        deleteSelectedPoint: () => false,
        blur: () => {},
    });
    apiRef.current = {
        escape: () => {
            if (strokeRef.current) {
                cancelFreedraw();
                return true;
            }
            if (eraserRef.current) {
                cancelEraser();
                return true;
            }
            if (lineRef.current) {
                // Escape keeps the committed points, dropping the trailing one (R2.12).
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
            return false;
        },
        finish: () => {
            if (!lineRef.current) return false;
            finishLineWith(lineRef.current.committed);
            return true;
        },
        // Delete/Backspace with a point SELECTED acts on THAT point, never the whole element (EP-PT). An
        // interior point is removed (one sealed step, winning over the keyboard hook's delete-selection).
        // A selected ENDPOINT (index 0/last, where an arrow's bindings ride) or any point of an elbow
        // arrow (route derived, no editable interior) is a no-op — but we STILL consume the key so it
        // cannot fall through and delete the element out from under a selected point. With no point
        // selected we return false and selection-delete removes the whole element as usual.
        deleteSelectedPoint: () => {
            const index = selectedPointIndex;
            if (index === null || !selectedLine) return false;
            const pts = parsePoints(selectedLine.points);
            const interior =
                !(selectedLine.type === 'arrow' && selectedLine.elbow) && index > 0 && index < pts.length - 1;
            if (!interior) return true; // endpoint / elbow → no-op, but consume (never delete the element)
            undoManager?.stopCapturing();
            updateElement(
                selectedLine.id,
                normalizeLinear(
                    selectedLine,
                    pts.filter((_, i) => i !== index),
                ),
            );
            undoManager?.stopCapturing();
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
        onPointerLeave,
    };
}
