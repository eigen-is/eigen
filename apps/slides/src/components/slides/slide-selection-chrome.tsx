import { cn } from '@workspace/ui/lib/utils';
import { RotateCw } from 'lucide-react';
import { pxToPercent, type SlideObject } from './types';

const RESIZE_HANDLES = [
    { mode: 'resize-nw', className: '-top-1.5 -left-1.5 cursor-nwse-resize' },
    { mode: 'resize-ne', className: '-top-1.5 -right-1.5 cursor-nesw-resize' },
    { mode: 'resize-sw', className: '-bottom-1.5 -left-1.5 cursor-nesw-resize' },
    { mode: 'resize-se', className: '-bottom-1.5 -right-1.5 cursor-nwse-resize' },
    { mode: 'resize-n', className: '-top-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize' },
    { mode: 'resize-s', className: '-bottom-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize' },
    { mode: 'resize-w', className: 'top-1/2 -left-1.5 -translate-y-1/2 cursor-ew-resize' },
    { mode: 'resize-e', className: 'top-1/2 -right-1.5 -translate-y-1/2 cursor-ew-resize' },
] as const;

type SelectionChromeProps = {
    obj: SlideObject;
    showRotate: boolean;
    onResizeStart: (
        e: React.MouseEvent,
        objId: string,
        mode: string,
        x: number,
        y: number,
        w: number,
        h: number,
        rotation: number,
    ) => void;
    onRotateStart: (
        e: React.MouseEvent,
        objId: string,
        x: number,
        y: number,
        w: number,
        h: number,
        rotation: number,
    ) => void;
};

// Selection chrome (ring + resize handles) drawn as a sibling overlay above all
// objects so it is never clipped by a rounded object's overflow:hidden and never
// hidden behind overlapping objects. Container is pointer-events-none so clicks on
// the object body fall through to the object (move / double-click-to-edit); only
// the handles capture events.
export function SelectionChrome({ obj, showRotate, onResizeStart, onRotateStart }: SelectionChromeProps) {
    return (
        <div
            className="absolute pointer-events-none eigen-selection-ring"
            style={{
                left: `${pxToPercent(obj.x, 'x')}%`,
                top: `${pxToPercent(obj.y, 'y')}%`,
                width: `${pxToPercent(obj.w, 'x')}%`,
                height: `${pxToPercent(obj.h, 'y')}%`,
                transform: obj.rotation ? `rotate(${obj.rotation}deg)` : undefined,
                transformOrigin: 'center center',
            }}
        >
            {RESIZE_HANDLES.map(({ mode, className }) => (
                <div
                    key={mode}
                    className={cn('eigen-selection-handle pointer-events-auto', className)}
                    onMouseDown={(e) => {
                        e.stopPropagation();
                        onResizeStart(e, obj.id, mode, obj.x, obj.y, obj.w, obj.h, obj.rotation);
                    }}
                />
            ))}
            {showRotate && (
                <>
                    <div className="absolute left-1/2 -translate-x-1/2 -top-6 h-6 w-px bg-selection-handle pointer-events-none" />
                    <div
                        className="absolute left-1/2 -translate-x-1/2 -top-9 flex h-4 w-4 items-center justify-center rounded-full bg-background border border-selection-handle pointer-events-auto cursor-grab"
                        onMouseDown={(e) => {
                            e.stopPropagation();
                            onRotateStart(e, obj.id, obj.x, obj.y, obj.w, obj.h, obj.rotation);
                        }}
                    >
                        <RotateCw className="h-2.5 w-2.5 text-selection-handle" />
                    </div>
                </>
            )}
        </div>
    );
}
