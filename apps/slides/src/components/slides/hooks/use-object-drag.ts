import {useCallback, useRef, useState} from 'react';
import {snapRect, SnapLine} from './use-snap-lines';

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

type UseObjectDragProps = {
    onUpdate: (objId: string, updates: {x?: number; y?: number; w?: number; h?: number}) => void;
    canvasRef: React.RefObject<HTMLDivElement | null>;
    vSnaps?: number[];
    hSnaps?: number[];
}

export const useObjectDrag = ({onUpdate, canvasRef, vSnaps = [], hSnaps = []}: UseObjectDragProps) => {
    const [isDragging, setIsDragging] = useState(false);
    const [activeSnapLines, setActiveSnapLines] = useState<SnapLine[]>([]);
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
            const dx = ((me.clientX - s.startX) / canvas.w) * 100;
            const dy = ((me.clientY - s.startY) / canvas.h) * 100;

            let x = s.startObjX;
            let y = s.startObjY;
            let w = s.startObjW;
            let h = s.startObjH;

            if (s.mode === 'move') {
                x = clamp(s.startObjX + dx, 0, 100 - w);
                y = clamp(s.startObjY + dy, 0, 100 - h);
            } else {
                const resized = applyResize(s.mode, dx, dy, s.startObjX, s.startObjY, s.startObjW, s.startObjH);
                x = resized.x; y = resized.y; w = resized.w; h = resized.h;
            }

            const snapped = snapRect({x, y, w, h}, snapsRef.current.vSnaps, snapsRef.current.hSnaps, s.mode);
            setActiveSnapLines(snapped.lines);
            onUpdate(s.objId, {x: snapped.x, y: snapped.y, w: snapped.w, h: snapped.h});
        };

        const handleMouseUp = () => {
            setIsDragging(false);
            setActiveSnapLines([]);
            stateRef.current = {objId: null, mode: null, startX: 0, startY: 0, startObjX: 0, startObjY: 0, startObjW: 0, startObjH: 0};
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }, [getCanvasSize, onUpdate]);

    return {isDragging, startDrag, activeSnapLines};
};

function clamp(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v));
}

const MIN_SIZE = 3;

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

    x = clamp(x, 0, 97);
    y = clamp(y, 0, 97);

    return {x, y, w, h};
}
