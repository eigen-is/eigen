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
        (e: React.MouseEvent, direction: string) => {
            e.preventDefault();
            e.stopPropagation();
            if (!aspectRatio) return;

            const startX = e.clientX;
            const startWidth = width || 300;
            const maxWidth = getMaxWidth();
            let currentWidth = startWidth;

            const handleMouseMove = (moveEvent: MouseEvent) => {
                const deltaX = moveEvent.clientX - startX;
                const isLeft = direction === 'w' || direction === 'nw' || direction === 'sw';
                const effectiveDelta = isLeft ? -deltaX : deltaX;
                // Floor last: a maxWidth measured while the surface was hidden is 0 or negative,
                // and clamping to it would write that width to the document.
                currentWidth = Math.max(100, Math.min(maxWidth, startWidth + effectiveDelta));
                setLocalWidth(Math.round(currentWidth));
            };

            const handleMouseUp = () => {
                setLocalWidth(null);
                onResize(Math.round(currentWidth));
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        },
        [width, aspectRatio, getMaxWidth, onResize],
    );

    const displayWidth = localWidth ?? width;

    return (
        <div className="relative inline-block group" style={{ width: displayWidth ? `${displayWidth}px` : undefined }}>
            {children}
            {selected && editable && (
                <>
                    <div
                        className="absolute top-1/2 -left-1.5 -translate-y-1/2 w-3 h-3 bg-background border border-selection-handle rounded-sm cursor-ew-resize"
                        onMouseDown={(e) => handleResizeStart(e, 'w')}
                    />
                    <div
                        className="absolute top-1/2 -right-1.5 -translate-y-1/2 w-3 h-3 bg-background border border-selection-handle rounded-sm cursor-ew-resize"
                        onMouseDown={(e) => handleResizeStart(e, 'e')}
                    />
                    <div
                        className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-background border border-selection-handle rounded-sm cursor-nwse-resize"
                        onMouseDown={(e) => handleResizeStart(e, 'se')}
                    />
                    <div
                        className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-background border border-selection-handle rounded-sm cursor-nesw-resize"
                        onMouseDown={(e) => handleResizeStart(e, 'ne')}
                    />
                </>
            )}
        </div>
    );
}
