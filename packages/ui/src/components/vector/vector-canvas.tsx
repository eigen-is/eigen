import {
    type Bounds,
    type Box,
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_SHAPE_ROUNDNESS,
    ELEMENT_FIELDS,
    elementToSvg,
    getElementsBounds,
    isTransparent,
    type MediaResolver,
    orderByFractionalIndex,
    type VectorElement,
    type VectorMeta,
} from '@workspace/lib/vector';
import { ObjectTransform } from '@workspace/ui/components/transform/object-transform';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { hitTestTopmost, marqueeContain, useSelection } from './hooks/use-selection';
import type { VectorTool } from './hooks/use-tool';
import type { NewVectorElement, VectorElementPatch } from './hooks/use-vector-doc';
import { useVectorKeyboard } from './hooks/use-vector-keyboard';
import { useViewport } from './hooks/use-viewport';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CREATING_ID = '__creating__';
// Below this scene-unit extent (in BOTH dimensions) a drag-create is a click → discarded (SCOUT §7).
const CREATE_MIN_SIZE = 1;
const MIN_ELEMENT_SIZE = 1;

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

function isTypingTarget(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable;
}

type Gesture =
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
    | { kind: 'marquee'; startX: number; startY: number; additive: boolean; base: string[] };

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
    // Images resolve to an <image> href; omitted → images render nothing (elementToSvg null path).
    resolveMedia?: MediaResolver;
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
    resolveMedia,
}: VectorCanvasProps) {
    const { selectedIds, setSelectedIds, toggle } = useSelection();
    const { containerRef, clientToScene, screenDeltaToScene, boxToStyle, groupTransform, panBy, frozenRef } =
        useViewport();

    const [previews, setPreviews] = useState<Record<string, Box>>({});
    const [creating, setCreating] = useState<CreatingState | null>(null);
    const [marquee, setMarquee] = useState<Box | null>(null);
    const [spaceHeld, setSpaceHeld] = useState(false);
    const [panning, setPanning] = useState(false);

    const gestureRef = useRef<Gesture | null>(null);
    // First onTransform of a resize/rotate is the de-facto gesture start (ObjectTransform's seam has
    // no onStart); flip it there for the one-stopCapturing-per-gesture rule.
    const transformStartedRef = useRef(false);

    const ordered = useMemo(() => orderByFractionalIndex(elements), [elements]);

    // An element renders with its live local preview (move/resize/rotate) overriding the Yjs values;
    // no preview → same object identity, so the memo skips it.
    const renderEl = (el: VectorElement): VectorElement => {
        const p = previews[el.id];
        return p ? { ...el, x: p.x, y: p.y, width: p.width, height: p.height, angle: p.angle } : el;
    };

    useVectorKeyboard({
        enabled: canWrite,
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

    // Safety net: any pointerup ends the freeze and clears the transform-start latch. This is what
    // unfreezes the viewport after an ObjectTransform resize/rotate (its pointer lifecycle is
    // internal), including its Escape-cancel path which fires no onCommit.
    useEffect(() => {
        const clear = () => {
            frozenRef.current = false;
            transformStartedRef.current = false;
        };
        document.addEventListener('pointerup', clear);
        document.addEventListener('pointercancel', clear);
        return () => {
            document.removeEventListener('pointerup', clear);
            document.removeEventListener('pointercancel', clear);
        };
    }, [frozenRef]);

    // Layered Escape (bubble phase): ObjectTransform claims mid-resize/rotate Escapes in the capture
    // phase and stops them, so this never fires during a grip drag. It cancels an in-progress
    // canvas gesture, else deselects, else returns to the select tool.
    const escRef = useRef({ hasSelection: false, tool });
    escRef.current = { hasSelection: selectedIds.length > 0, tool };
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            const g = gestureRef.current;
            if (g) {
                gestureRef.current = null;
                frozenRef.current = false;
                if (g.kind === 'create') {
                    setCreating(null);
                    setTool('select');
                } else if (g.kind === 'marquee') {
                    setMarquee(null);
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

    const onPointerDown = (e: React.PointerEvent) => {
        if (frozenRef.current) return; // a gesture is already active (defensive)
        // Pan: space-drag or middle mouse.
        if (spaceHeld || e.button === 1) {
            e.preventDefault();
            containerRef.current?.setPointerCapture(e.pointerId);
            frozenRef.current = true;
            setPanning(true);
            gestureRef.current = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
            return;
        }
        if (e.button !== 0) return;
        if (!canWrite) return;

        containerRef.current?.setPointerCapture(e.pointerId);
        const p = clientToScene(e.clientX, e.clientY);

        // Shape tool → start a local (not-yet-Yjs) drag-create.
        if (tool !== 'select') {
            frozenRef.current = true;
            undoManager?.stopCapturing();
            setSelectedIds([]);
            gestureRef.current = { kind: 'create', startX: p.x, startY: p.y };
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
            gestureRef.current = { kind: 'move', startX: p.x, startY: p.y, originals, ids, moved: false };
            return;
        }

        // Empty space → marquee (Shift = additive; else clear first, then select contained).
        frozenRef.current = true;
        const additive = e.shiftKey;
        if (!additive) setSelectedIds([]);
        gestureRef.current = { kind: 'marquee', startX: p.x, startY: p.y, additive, base: additive ? selectedIds : [] };
        setMarquee({ x: p.x, y: p.y, width: 0, height: 0, angle: 0 });
    };

    const onPointerMove = (e: React.PointerEvent) => {
        const g = gestureRef.current;
        if (!g) return;
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

    const onPointerUp = () => {
        const g = gestureRef.current;
        gestureRef.current = null;
        frozenRef.current = false;
        if (!g) return;

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
            }
            return;
        }
        if (g.kind === 'move') {
            if (g.moved) {
                const patches = g.ids
                    .filter((id) => previews[id])
                    .map((id) => ({ id, fields: { x: previews[id].x, y: previews[id].y } }));
                if (patches.length) updateElements(patches);
            }
            setPreviews({});
            return;
        }
        // marquee: selection was set live during the move; a plain click already cleared it.
        setMarquee(null);
    };

    const selectedRender = ordered.filter((el) => selectedIds.includes(el.id)).map(renderEl);
    const single = selectedRender.length === 1 ? selectedRender[0] : null;
    const unionBox = selectedRender.length >= 1 ? boundsToBox(getElementsBounds(selectedRender.map(elementBox))) : null;
    // Chrome is suppressed while a create/marquee drag is in flight (grip flicker); move keeps it
    // (the ring follows the moving element). Single + write → full transform; everything else → a
    // plain translate-only union ring (multi-select never mounts ObjectTransform, UX-RULING 7).
    const showChrome = !creating && !marquee;
    const showTransform = showChrome && canWrite && single !== null;

    const cursor = panning ? 'grabbing' : spaceHeld ? 'grab' : tool !== 'select' ? 'crosshair' : 'default';
    const background = isTransparent(meta.background) ? undefined : meta.background;

    return (
        <div
            ref={containerRef}
            className="relative h-full w-full select-none overflow-hidden bg-muted/30 touch-none"
            style={{ cursor, backgroundColor: background }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
        >
            <svg className="pointer-events-none absolute inset-0 h-full w-full" xmlns={SVG_NS}>
                <g transform={groupTransform}>
                    {ordered.map((el) => (
                        <ElementNode key={el.id} el={renderEl(el)} resolveMedia={resolveMedia} />
                    ))}
                    {creating && <ElementNode el={creatingElement(creating)} resolveMedia={resolveMedia} />}
                </g>
            </svg>
            <div className="pointer-events-none absolute inset-0">
                {showTransform && single && (
                    <ObjectTransform
                        box={elementBox(single)}
                        boxToStyle={boxToStyle}
                        screenDeltaToScene={screenDeltaToScene}
                        showRotate
                        minSize={MIN_ELEMENT_SIZE}
                        onTransform={(next) => {
                            if (!transformStartedRef.current) {
                                transformStartedRef.current = true;
                                frozenRef.current = true;
                                undoManager?.stopCapturing();
                            }
                            setPreviews({ [single.id]: next });
                        }}
                        onCommit={(next) => {
                            transformStartedRef.current = false;
                            frozenRef.current = false;
                            updateElement(single.id, {
                                x: next.x,
                                y: next.y,
                                width: next.width,
                                height: next.height,
                                angle: next.angle,
                            });
                            setPreviews({});
                        }}
                    />
                )}
                {showChrome && !showTransform && unionBox && (
                    <div className="eigen-selection-ring pointer-events-none absolute" style={boxToStyle(unionBox)} />
                )}
                {marquee && (
                    <div
                        className="pointer-events-none absolute border border-selection-handle/70 bg-selection-handle/10"
                        style={boxToStyle(marquee)}
                    />
                )}
            </div>
        </div>
    );
}
