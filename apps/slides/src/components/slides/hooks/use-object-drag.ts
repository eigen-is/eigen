import {useCallback, useRef, useState} from 'react';
import {snapRect, SnapLine} from './use-snap-lines';
import {SLIDE_BASE_WIDTH, SLIDE_BASE_HEIGHT} from '../types';

type DragMode = 'move' | 'resize-se' | 'resize-sw' | 'resize-ne' | 'resize-nw' | 'resize-e' | 'resize-w' | 'resize-n' | 'resize-s' | null;

type ObjectDragState = {
    objId: string | null;
    mode: DragMode;
    startX: number;
    startY: number;
    startObjX: number;
    startObjY: number;
    startObjW: number;
    startObjH: number;
}

export type DragPreview = {
    objId: string;
    x: number;
    y: number;
    w: number;
    h: number;
} | null;

type UseObjectDragProps = {
    onUpdate: (objId: string, updates: {x?: number; y?: number; w?: number; h?: number}) => void;
    canvasRef: React.RefObject<HTMLDivElement | null>;
    vSnaps?: number[];
    hSnaps?: number[];
}

export const useObjectDrag = ({onUpdate, canvasRef, vSnaps = [], hSnaps = []}: UseObjectDragProps) => {
    const [isDragging, setIsDragging] = useState(false);
    const [activeSnapLines, setActiveSnapLines] = useState<SnapLine[]>([]);
    const [dragPreview, setDragPreview] = useState<DragPreview>(null);
    const lastSnappedRef = useRef<{x: number; y: number; w: number; h: number} | null>(null);
    const snapsRef = useRef({vSnaps, hSnaps});
    snapsRef.current = {vSnaps, hSnaps};
    const stateRef = useRef<ObjectDragState>({
        objId: null, mode: null,
        startX: 0, startY: 0,
        startObjX: 0, startObjY: 0,
        startObjW: 0, startObjH: 0,
    });

    const getCanvasSize = useCallback(() => {
        const el = canvasRef.current;
        if (!el) return {w: 1, h: 1};
        return {w: el.clientWidth, h: el.clientHeight};
    }, [canvasRef]);

    const startDrag = useCallback((
        e: React.MouseEvent,
        objId: string,
        mode: DragMode,
        objX: number, objY: number, objW: number, objH: number,
    ) => {
        e.preventDefault();
        e.stopPropagation();
        stateRef.current = {
            objId, mode,
            startX: e.clientX, startY: e.clientY,
            startObjX: objX, startObjY: objY,
            startObjW: objW, startObjH: objH,
        };
        setIsDragging(true);

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
                x = resized.x; y = resized.y; w = resized.w; h = resized.h;
            }

            const snapped = snapRect({x, y, w, h}, snapsRef.current.vSnaps, snapsRef.current.hSnaps, s.mode);
            setActiveSnapLines(snapped.lines);
            lastSnappedRef.current = {x: snapped.x, y: snapped.y, w: snapped.w, h: snapped.h};
            setDragPreview({objId: s.objId, x: snapped.x, y: snapped.y, w: snapped.w, h: snapped.h});
        };

        const handleMouseUp = () => {
            const s = stateRef.current;
            if (s.objId && lastSnappedRef.current) {
                onUpdate(s.objId, lastSnappedRef.current);
            }
            setIsDragging(false);
            setActiveSnapLines([]);
            setDragPreview(null);
            lastSnappedRef.current = null;
            stateRef.current = {objId: null, mode: null, startX: 0, startY: 0, startObjX: 0, startObjY: 0, startObjW: 0, startObjH: 0};
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }, [getCanvasSize, onUpdate]);

    return {isDragging, startDrag, activeSnapLines, dragPreview};
};

const MIN_SIZE = 30;

function applyResize(
    mode: DragMode,
    dx: number, dy: number,
    ox: number, oy: number, ow: number, oh: number,
) {
    let x = ox, y = oy, w = ow, h = oh;

    if (mode?.includes('e')) { w = Math.max(MIN_SIZE, ow + dx); }
    if (mode?.includes('w')) { w = Math.max(MIN_SIZE, ow - dx); x = ox + ow - w; }
    if (mode?.includes('s')) { h = Math.max(MIN_SIZE, oh + dy); }
    if (mode?.includes('n')) { h = Math.max(MIN_SIZE, oh - dy); y = oy + oh - h; }

    return {x, y, w, h};
}
