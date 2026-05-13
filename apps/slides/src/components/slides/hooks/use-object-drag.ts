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
            const cursor = {
                clientX: e.clientX,
                clientY: e.clientY,
                altKey: e.altKey,
                shiftKey: e.shiftKey,
            };

            const update = () => {
                const s = stateRef.current;
                if (!s.objId || !s.mode) return;
                const canvas = getCanvasSize();
                const dx = ((cursor.clientX - s.startX) / canvas.w) * SLIDE_BASE_WIDTH;
                const dy = ((cursor.clientY - s.startY) / canvas.h) * SLIDE_BASE_HEIGHT;
                const isResize = s.mode !== 'move';
                const fromCenter = cursor.altKey && isResize;
                const keepAspect = cursor.shiftKey && isResize;

                let x = s.startObjX;
                let y = s.startObjY;
                let w = s.startObjW;
                let h = s.startObjH;

                if (s.mode === 'move') {
                    x = s.startObjX + dx;
                    y = s.startObjY + dy;
                } else {
                    const resized = applyResize(
                        s.mode,
                        dx,
                        dy,
                        { x: s.startObjX, y: s.startObjY, w: s.startObjW, h: s.startObjH },
                        { fromCenter, keepAspect },
                    );
                    x = resized.x;
                    y = resized.y;
                    w = resized.w;
                    h = resized.h;
                }

                // Snapping per-edge would break the center mirror / aspect lock, so skip it while modifiers are held.
                const snapped =
                    fromCenter || keepAspect
                        ? { x, y, w, h, lines: [] as SnapLine[] }
                        : snapRect({ x, y, w, h }, snapsRef.current.vSnaps, snapsRef.current.hSnaps, s.mode);
                setActiveSnapLines(snapped.lines);
                lastSnappedRef.current = { x: snapped.x, y: snapped.y, w: snapped.w, h: snapped.h };
                setDragPreviews([{ objId: s.objId, x: snapped.x, y: snapped.y, w: snapped.w, h: snapped.h }]);
            };

            const handleMouseMove = (me: MouseEvent) => {
                cursor.clientX = me.clientX;
                cursor.clientY = me.clientY;
                cursor.altKey = me.altKey;
                cursor.shiftKey = me.shiftKey;
                update();
            };

            const handleKey = (ke: KeyboardEvent) => {
                if (ke.key !== 'Alt' && ke.key !== 'Shift') return;
                cursor.altKey = ke.altKey;
                cursor.shiftKey = ke.shiftKey;
                update();
            };

            const endDrag = () => {
                const s = stateRef.current;
                if (s.objId && lastSnappedRef.current) {
                    onUpdate(s.objId, lastSnappedRef.current);
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

function applyResize(
    mode: DragMode,
    dx: number,
    dy: number,
    { x: ox, y: oy, w: ow, h: oh }: { x: number; y: number; w: number; h: number },
    { fromCenter, keepAspect }: { fromCenter: boolean; keepAspect: boolean },
) {
    const xDir = mode?.includes('e') ? 1 : mode?.includes('w') ? -1 : 0;
    const yDir = mode?.includes('s') ? 1 : mode?.includes('n') ? -1 : 0;
    // Aspect lock only applies to corners — on edges only one axis is intentional.
    const aspectLocked = keepAspect && xDir !== 0 && yDir !== 0 && ow > 0 && oh > 0;

    let dw = xDir * dx;
    let dh = yDir * dy;

    if (aspectLocked) {
        const aspect = ow / oh;
        if (Math.abs(dw / ow) >= Math.abs(dh / oh)) {
            dh = dw / aspect;
        } else {
            dw = dh * aspect;
        }
    }

    const sizeFactor = fromCenter ? 2 : 1;
    let w = ow + sizeFactor * dw;
    let h = oh + sizeFactor * dh;

    if (aspectLocked) {
        // Clamp both dimensions through a single scale so the ratio survives the MIN_SIZE floor.
        const scale = Math.max(w / ow, MIN_SIZE / ow, MIN_SIZE / oh);
        w = ow * scale;
        h = oh * scale;
    } else {
        w = Math.max(MIN_SIZE, w);
        h = Math.max(MIN_SIZE, h);
    }

    let x: number;
    let y: number;
    if (fromCenter) {
        x = ox + (ow - w) / 2;
        y = oy + (oh - h) / 2;
    } else {
        x = xDir === -1 ? ox + ow - w : ox;
        y = yDir === -1 ? oy + oh - h : oy;
    }

    return { x, y, w, h };
}
