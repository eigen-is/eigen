import { useCallback, useRef, useState } from 'react';
import { SLIDE_BASE_HEIGHT, SLIDE_BASE_WIDTH, type SlideObject } from '../types';
import { type SnapLine, snapRect } from './use-snap-lines';

// Object MOVE + group move. Resize and rotate live in the shared ObjectTransform now (the slides
// selection chrome), so this hook only translates objects — one gesture = one commit that writes
// ONLY the changed x/y (never the whole box), so a concurrent peer resize survives the merge.

type ObjectDragState = {
    objId: string | null;
    startX: number;
    startY: number;
    startObjX: number;
    startObjY: number;
    // Kept for the snap rect (edges) and the rotated-object snap-skip below; a rotated box's
    // axis-aligned snap rect doesn't match its visual box, so it is not snapped.
    startObjW: number;
    startObjH: number;
    startAngle: number;
};

type GroupDragState = {
    startX: number;
    startY: number;
    objects: { id: string; x: number; y: number; w: number; h: number }[];
    bounds: { x: number; y: number; w: number; h: number };
};

type DragPreview = { objId: string; x: number; y: number };

type UseObjectDragProps = {
    onUpdate: (objId: string, updates: { x?: number; y?: number }) => void;
    onDuplicate?: (placements: { id: string; x: number; y: number }[]) => void;
    canvasRef: React.RefObject<HTMLDivElement | null>;
    vSnaps?: number[];
    hSnaps?: number[];
};

export const useObjectDrag = ({ onUpdate, onDuplicate, canvasRef, vSnaps = [], hSnaps = [] }: UseObjectDragProps) => {
    const [activeSnapLines, setActiveSnapLines] = useState<SnapLine[]>([]);
    const [dragPreviews, setDragPreviews] = useState<DragPreview[]>([]);
    const lastSnappedRef = useRef<{ x: number; y: number } | null>(null);
    const lastGroupDeltaRef = useRef<{ dx: number; dy: number } | null>(null);
    const snapsRef = useRef({ vSnaps, hSnaps });
    snapsRef.current = { vSnaps, hSnaps };
    const stateRef = useRef<ObjectDragState>({
        objId: null,
        startX: 0,
        startY: 0,
        startObjX: 0,
        startObjY: 0,
        startObjW: 0,
        startObjH: 0,
        startAngle: 0,
    });
    const groupStateRef = useRef<GroupDragState | null>(null);

    const getCanvasSize = useCallback(() => {
        const el = canvasRef.current;
        if (!el) return { w: 1, h: 1 };
        return { w: el.clientWidth, h: el.clientHeight };
    }, [canvasRef]);

    const startDrag = useCallback(
        (e: React.MouseEvent, objId: string, objX: number, objY: number, objW: number, objH: number, angle = 0) => {
            e.preventDefault();
            e.stopPropagation();
            stateRef.current = {
                objId,
                startX: e.clientX,
                startY: e.clientY,
                startObjX: objX,
                startObjY: objY,
                startObjW: objW,
                startObjH: objH,
                startAngle: angle,
            };
            groupStateRef.current = null;
            const cursor = { clientX: e.clientX, clientY: e.clientY, altKey: e.altKey };

            const update = () => {
                const s = stateRef.current;
                if (!s.objId) return;

                const canvas = getCanvasSize();
                const dx = ((cursor.clientX - s.startX) / canvas.w) * SLIDE_BASE_WIDTH;
                const dy = ((cursor.clientY - s.startY) / canvas.h) * SLIDE_BASE_HEIGHT;
                const x = s.startObjX + dx;
                const y = s.startObjY + dy;

                // A rotated object's axis-aligned snap rect doesn't match its visual box — skip snapping.
                const snapped =
                    s.startAngle !== 0
                        ? { x, y, w: s.startObjW, h: s.startObjH, lines: [] as SnapLine[] }
                        : snapRect(
                              { x, y, w: s.startObjW, h: s.startObjH },
                              snapsRef.current.vSnaps,
                              snapsRef.current.hSnaps,
                              'move',
                          );

                // Mousemove fires ~60Hz; bail when the snapped position is identical to skip re-renders.
                const prev = lastSnappedRef.current;
                if (prev && prev.x === snapped.x && prev.y === snapped.y) return;
                lastSnappedRef.current = { x: snapped.x, y: snapped.y };
                setActiveSnapLines(snapped.lines);
                setDragPreviews([{ objId: s.objId, x: snapped.x, y: snapped.y }]);
            };

            const handleMouseMove = (me: MouseEvent) => {
                cursor.clientX = me.clientX;
                cursor.clientY = me.clientY;
                cursor.altKey = me.altKey;
                update();
            };

            const handleKey = (ke: KeyboardEvent) => {
                if (ke.key !== 'Alt') return;
                cursor.altKey = ke.altKey;
            };

            const endDrag = () => {
                const s = stateRef.current;
                if (s.objId && lastSnappedRef.current) {
                    const { x, y } = lastSnappedRef.current;
                    if (cursor.altKey && onDuplicate) {
                        onDuplicate([{ id: s.objId, x, y }]);
                    } else {
                        // Move writes ONLY x/y — never w/h/angle — so a concurrent peer resize survives.
                        onUpdate(s.objId, { x, y });
                    }
                }
                cleanup();
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', endDrag);
                document.removeEventListener('keydown', handleKey);
                document.removeEventListener('keyup', handleKey);
                window.removeEventListener('blur', endDrag);
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', endDrag);
            document.addEventListener('keydown', handleKey);
            document.addEventListener('keyup', handleKey);
            // Commit and tear down on focus loss (alt-tab, devtools opening) — browsers can drop mouseup.
            window.addEventListener('blur', endDrag);
        },
        [getCanvasSize, onUpdate, onDuplicate],
    );

    const startGroupDrag = useCallback(
        (
            e: React.MouseEvent,
            selectedObjects: SlideObject[],
            bounds: { x: number; y: number; w: number; h: number },
        ) => {
            e.preventDefault();
            e.stopPropagation();
            groupStateRef.current = {
                startX: e.clientX,
                startY: e.clientY,
                objects: selectedObjects.map((o) => ({ id: o.id, x: o.x, y: o.y, w: o.width, h: o.height })),
                bounds,
            };
            stateRef.current = {
                objId: null,
                startX: 0,
                startY: 0,
                startObjX: 0,
                startObjY: 0,
                startObjW: 0,
                startObjH: 0,
                startAngle: 0,
            };

            const cursor = { altKey: e.altKey };
            const handleKey = (ke: KeyboardEvent) => {
                if (ke.key !== 'Alt') return;
                cursor.altKey = ke.altKey;
            };

            const handleMouseMove = (me: MouseEvent) => {
                cursor.altKey = me.altKey;
                const g = groupStateRef.current;
                if (!g) return;
                const canvas = getCanvasSize();
                const dx = ((me.clientX - g.startX) / canvas.w) * SLIDE_BASE_WIDTH;
                const dy = ((me.clientY - g.startY) / canvas.h) * SLIDE_BASE_HEIGHT;

                // Snap the bounding box, then derive the snapped delta
                const movedBounds = { x: g.bounds.x + dx, y: g.bounds.y + dy, w: g.bounds.w, h: g.bounds.h };
                const snapped = snapRect(movedBounds, snapsRef.current.vSnaps, snapsRef.current.hSnaps, 'move');
                const snapDx = snapped.x - g.bounds.x;
                const snapDy = snapped.y - g.bounds.y;

                const prev = lastGroupDeltaRef.current;
                if (prev && prev.dx === snapDx && prev.dy === snapDy) return;
                lastGroupDeltaRef.current = { dx: snapDx, dy: snapDy };
                setActiveSnapLines(snapped.lines);
                setDragPreviews(g.objects.map((o) => ({ objId: o.id, x: o.x + snapDx, y: o.y + snapDy })));
            };

            const handleMouseUp = () => {
                const g = groupStateRef.current;
                const delta = lastGroupDeltaRef.current;
                if (g && delta) {
                    if (cursor.altKey && onDuplicate) {
                        onDuplicate(g.objects.map((o) => ({ id: o.id, x: o.x + delta.dx, y: o.y + delta.dy })));
                    } else {
                        for (const o of g.objects) {
                            onUpdate(o.id, { x: o.x + delta.dx, y: o.y + delta.dy });
                        }
                    }
                }
                cleanup();
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
                document.removeEventListener('keydown', handleKey);
                document.removeEventListener('keyup', handleKey);
                window.removeEventListener('blur', handleMouseUp);
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
            document.addEventListener('keydown', handleKey);
            document.addEventListener('keyup', handleKey);
            // Commit and tear down on focus loss (alt-tab, devtools opening) — browsers can drop mouseup.
            window.addEventListener('blur', handleMouseUp);
        },
        [getCanvasSize, onUpdate, onDuplicate],
    );

    const cleanup = useCallback(() => {
        setActiveSnapLines([]);
        setDragPreviews([]);
        lastSnappedRef.current = null;
        lastGroupDeltaRef.current = null;
        groupStateRef.current = null;
        stateRef.current = {
            objId: null,
            startX: 0,
            startY: 0,
            startObjX: 0,
            startObjY: 0,
            startObjW: 0,
            startObjH: 0,
            startAngle: 0,
        };
    }, []);

    return { startDrag, startGroupDrag, activeSnapLines, dragPreviews };
};
