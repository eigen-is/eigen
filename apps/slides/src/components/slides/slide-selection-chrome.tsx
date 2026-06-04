import { cn } from '@workspace/ui/lib/utils';
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
    onResizeStart: (
        e: React.MouseEvent,
        objId: string,
        mode: string,
        x: number,
        y: number,
        w: number,
        h: number,
    ) => void;
};

// Selection chrome (ring + resize handles) drawn as a sibling overlay above all
// objects so it is never clipped by a rounded object's overflow:hidden and never
// hidden behind overlapping objects. Container is pointer-events-none so clicks on
// the object body fall through to the object (move / double-click-to-edit); only
// the handles capture events.
export function SelectionChrome({ obj, onResizeStart }: SelectionChromeProps) {
    return (
        <div
            className="absolute pointer-events-none ring-1 ring-selection-handle"
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
                    className={cn(
                        'absolute h-3 w-3 bg-background border border-selection-handle rounded-sm pointer-events-auto',
                        className,
                    )}
                    onMouseDown={(e) => {
                        e.stopPropagation();
                        onResizeStart(e, obj.id, mode, obj.x, obj.y, obj.w, obj.h);
                    }}
                />
            ))}
        </div>
    );
}
