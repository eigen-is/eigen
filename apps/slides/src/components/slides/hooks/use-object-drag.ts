import { useCallback, useRef, useState } from 'react';
import { SLIDE_BASE_HEIGHT, SLIDE_BASE_WIDTH, type SlideObject } from '../types';
import { type SnapLine, snapRect } from './use-snap-lines';

export type DragMode =
    | 'move'
    | 'resize-se'
    | 'resize-sw'
    | 'resize-ne'
    | 'resize-nw'
    | 'resize-e'
    | 'resize-w'
    | 'resize-n'
    | 'resize-s'
    | null;

type ObjectDragState = {
    objId: string | null;
    mode: DragMode;
    startX: number;
    startY: number;
    startObjX: number;
    startObjY: number;
    startObjW: number;
    startObjH: number;
};

type GroupDragState = {
    startX: number;
    startY: number;
    objects: { id: string; x: number; y: number; w: number; h: number }[];
    bounds: { x: number; y: number; w: number; h: number };
};

type DragPreview = {
    objId: string;
    x: number;
    y: number;
    w: number;
    h: number;
};

type UseObjectDragProps = {
    onUpdate: (objId: string, updates: { x?: number; y?: number; w?: number; h?: number }) => void;
    canvasRef: React.RefObject<HTMLDivElement | null>;
    vSnaps?: number[];
    hSnaps?: number[];
};

export const useObjectDrag = ({ onUpdate, canvasRef, vSnaps = [], hSnaps = [] }: UseObjectDragProps) => {
    const [activeSnapLines, setActiveSnapLines] = useState<SnapLine[]>([]);
    const [dragPreviews, setDragPreviews] = useState<DragPreview[]>([]);
    const lastSnappedRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
    const lastGroupDeltaRef = useRef<{ dx: number; dy: number } | null>(null);
    const snapsRef = useRef({ vSnaps, hSnaps });
    snapsRef.current = { vSnaps, hSnaps };
    const stateRef = useRef<ObjectDragState>({
        objId: null,
        mode: null,
        startX: 0,
        startY: 0,
        startObjX: 0,
        startObjY: 0,
        startObjW: 0,
        startObjH: 0,
    });
    const groupStateRef = useRef<GroupDragState | null>(null);

    const getCanvasSize = useCallback(() => {
        const el = canvasRef.current;
        if (!el) return { w: 1, h: 1 };
        return { w: el.clientWidth, h: el.clientHeight };
    }, [canvasRef]);

    const startDrag = useCallback(
        (
            e: React.MouseEvent,
            objId: string,
            mode: DragMode,
            objX: number,
            objY: number,
            objW: number,
            objH: number,
        ) => {
            e.preventDefault();
            e.stopPropagation();
            stateRef.current = {
                objId,
                mode,
                startX: e.clientX,
                startY: e.clientY,
                startObjX: objX,
                startObjY: objY,
                startObjW: objW,
                startObjH: objH,
            };
            groupStateRef.current = null;

            const handleMouseMove = (me: MouseEvent) => {
                const s = stateRef.current;
                if (!s.objId || !s.mode) return;
                const canvas = getCanvasSize();
                const dx = ((me.clientX - s.startX) / canvas.w) * SLIDE_BASE_WIDTH;
                const dy = ((me.clientY - s.startY) / canvas.h) * SLIDE_BASE_HEIGHT;

                let x = s.startObjX;
                let y = s.startObjY;
                let w = s.startObjW;
                let h = s.startObjH;

                if (s.mode === 'move') {
                    x = s.startObjX + dx;
                    y = s.startObjY + dy;
                } else {
                    const resized = applyResize(s.mode, dx, dy, s.startObjX, s.startObjY, s.startObjW, s.startObjH);
                    x = resized.x;
                    y = resized.y;
                    w = resized.w;
                    h = resized.h;
                }

                const snapped = snapRect({ x, y, w, h }, snapsRef.current.vSnaps, snapsRef.current.hSnaps, s.mode);
                setActiveSnapLines(snapped.lines);
                lastSnappedRef.current = { x: snapped.x, y: snapped.y, w: snapped.w, h: snapped.h };
                setDragPreviews([{ objId: s.objId, x: snapped.x, y: snapped.y, w: snapped.w, h: snapped.h }]);
            };

            const handleMouseUp = () => {
                const s = stateRef.current;
                if (s.objId && lastSnappedRef.current) {
                    onUpdate(s.objId, lastSnappedRef.current);
                }
                cleanup();
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        },
        [getCanvasSize, onUpdate],
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
                objects: selectedObjects.map((o) => ({ id: o.id, x: o.x, y: o.y, w: o.w, h: o.h })),
                bounds,
            };
            stateRef.current = {
                objId: null,
                mode: null,
                startX: 0,
                startY: 0,
                startObjX: 0,
                startObjY: 0,
                startObjW: 0,
                startObjH: 0,
            };

            const handleMouseMove = (me: MouseEvent) => {
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

                setActiveSnapLines(snapped.lines);
                lastGroupDeltaRef.current = { dx: snapDx, dy: snapDy };
                setDragPreviews(
                    g.objects.map((o) => ({
                        objId: o.id,
                        x: o.x + snapDx,
                        y: o.y + snapDy,
                        w: o.w,
                        h: o.h,
                    })),
                );
            };

            const handleMouseUp = () => {
                const g = groupStateRef.current;
                const delta = lastGroupDeltaRef.current;
                if (g && delta) {
                    for (const o of g.objects) {
                        onUpdate(o.id, { x: o.x + delta.dx, y: o.y + delta.dy });
                    }
                }
                cleanup();
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        },
        [getCanvasSize, onUpdate],
    );

    const cleanup = useCallback(() => {
        setActiveSnapLines([]);
        setDragPreviews([]);
        lastSnappedRef.current = null;
        lastGroupDeltaRef.current = null;
        groupStateRef.current = null;
        stateRef.current = {
            objId: null,
            mode: null,
            startX: 0,
            startY: 0,
            startObjX: 0,
            startObjY: 0,
            startObjW: 0,
            startObjH: 0,
        };
    }, []);

    return { startDrag, startGroupDrag, activeSnapLines, dragPreviews };
};

const MIN_SIZE = 30;

function applyResize(mode: DragMode, dx: number, dy: number, ox: number, oy: number, ow: number, oh: number) {
    let x = ox,
        y = oy,
        w = ow,
        h = oh;

    if (mode?.includes('e')) {
        w = Math.max(MIN_SIZE, ow + dx);
    }
    if (mode?.includes('w')) {
        w = Math.max(MIN_SIZE, ow - dx);
        x = ox + ow - w;
    }
    if (mode?.includes('s')) {
        h = Math.max(MIN_SIZE, oh + dy);
    }
    if (mode?.includes('n')) {
        h = Math.max(MIN_SIZE, oh - dy);
        y = oy + oh - h;
    }

    return { x, y, w, h };
}
