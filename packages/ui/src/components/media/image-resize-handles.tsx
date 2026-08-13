import { cn } from '@workspace/ui/lib/utils';
import { useCallback, useState } from 'react';

type ImageResizeHandlesProps = {
    width: number | null;
    aspectRatio: number | null;
    // Called at drag start, not per render: measuring it costs a forced layout.
    getMaxWidth: () => number;
    onResize: (width: number) => void;
    children: React.ReactNode;
    selected?: boolean;
    editable?: boolean;
};

const RESIZE_HANDLES = [
    { direction: 'w', className: 'top-1/2 -left-1.5 -translate-y-1/2 cursor-ew-resize' },
    { direction: 'e', className: 'top-1/2 -right-1.5 -translate-y-1/2 cursor-ew-resize' },
    { direction: 'se', className: '-bottom-1.5 -right-1.5 cursor-nwse-resize' },
    { direction: 'ne', className: '-top-1.5 -right-1.5 cursor-nesw-resize' },
] as const;

export function ImageResizeHandles({
    width,
    aspectRatio,
    getMaxWidth,
    onResize,
    children,
    selected = false,
    editable = true,
}: ImageResizeHandlesProps) {
    const [localWidth, setLocalWidth] = useState<number | null>(null);

    const handleResizeStart = useCallback(
        (e: React.PointerEvent, direction: string) => {
            e.preventDefault();
            e.stopPropagation();
            if (!aspectRatio) return;

            // Capture keeps the drag alive through the pointer stream on touch, where a scroll gesture
            // would otherwise steal it.
            e.currentTarget.setPointerCapture(e.pointerId);
            const startX = e.clientX;
            const startWidth = width || 300;
            const maxWidth = getMaxWidth();
            let currentWidth = startWidth;

            const handlePointerMove = (moveEvent: PointerEvent) => {
                const deltaX = moveEvent.clientX - startX;
                const isLeft = direction === 'w' || direction === 'nw' || direction === 'sw';
                const effectiveDelta = isLeft ? -deltaX : deltaX;
                // Floor last so it wins over maxWidth: a maxWidth measured while the surface was hidden
                // is 0 or negative, and clamping to it would shrink the image below usable.
                currentWidth = Math.max(100, Math.min(maxWidth, startWidth + effectiveDelta));
                setLocalWidth(Math.round(currentWidth));
            };

            const handlePointerUp = () => {
                setLocalWidth(null);
                onResize(Math.round(currentWidth));
                document.removeEventListener('pointermove', handlePointerMove);
                document.removeEventListener('pointerup', handlePointerUp);
            };

            document.addEventListener('pointermove', handlePointerMove);
            document.addEventListener('pointerup', handlePointerUp);
        },
        [width, aspectRatio, getMaxWidth, onResize],
    );

    const handleKeyResize = useCallback(
        (e: React.KeyboardEvent) => {
            const step = e.shiftKey ? 1 : 10;
            const delta =
                e.key === 'ArrowRight' || e.key === 'ArrowUp'
                    ? step
                    : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
                      ? -step
                      : 0;
            if (delta === 0) return;
            e.preventDefault();
            e.stopPropagation();
            const next = Math.max(100, Math.min(getMaxWidth(), (width || 300) + delta));
            onResize(Math.round(next));
        },
        [width, getMaxWidth, onResize],
    );

    const displayWidth = localWidth ?? width;

    return (
        <div
            className={cn('relative inline-block', selected && 'eigen-selection-ring')}
            style={{ width: displayWidth ? `${displayWidth}px` : undefined }}
        >
            {children}
            {selected &&
                editable &&
                RESIZE_HANDLES.map(({ direction, className }) => (
                    <button
                        key={direction}
                        type="button"
                        aria-label="Resize image"
                        className={cn('eigen-selection-handle touch-none p-0', className)}
                        onPointerDown={(e) => handleResizeStart(e, direction)}
                        onKeyDown={handleKeyResize}
                    />
                ))}
        </div>
    );
}
