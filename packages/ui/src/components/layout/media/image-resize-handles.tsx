import { useCallback, useState } from 'react';

type ImageResizeHandlesProps = {
    width: number | null;
    aspectRatio: number | null;
    maxWidth: number;
    onResize: (width: number) => void;
    children: React.ReactNode;
    selected?: boolean;
    editable?: boolean;
};

export function ImageResizeHandles({
    width,
    aspectRatio,
    maxWidth,
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
            let currentWidth = startWidth;

            const handleMouseMove = (moveEvent: MouseEvent) => {
                const deltaX = moveEvent.clientX - startX;
                const isLeft = direction === 'w' || direction === 'nw' || direction === 'sw';
                const effectiveDelta = isLeft ? -deltaX : deltaX;
                currentWidth = Math.min(maxWidth, Math.max(100, startWidth + effectiveDelta));
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
        [width, aspectRatio, maxWidth, onResize],
    );

    const displayWidth = localWidth ?? width;

    return (
        <div className="relative inline-block group" style={{ width: displayWidth ? `${displayWidth}px` : undefined }}>
            {children}
            {selected && editable && (
                <>
                    <div
                        className="absolute top-1/2 -left-1.5 -translate-y-1/2 w-3 h-3 bg-white border border-blue-500 rounded-sm cursor-ew-resize"
                        onMouseDown={(e) => handleResizeStart(e, 'w')}
                    />
                    <div
                        className="absolute top-1/2 -right-1.5 -translate-y-1/2 w-3 h-3 bg-white border border-blue-500 rounded-sm cursor-ew-resize"
                        onMouseDown={(e) => handleResizeStart(e, 'e')}
                    />
                    <div
                        className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-white border border-blue-500 rounded-sm cursor-nwse-resize"
                        onMouseDown={(e) => handleResizeStart(e, 'se')}
                    />
                    <div
                        className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-white border border-blue-500 rounded-sm cursor-nesw-resize"
                        onMouseDown={(e) => handleResizeStart(e, 'ne')}
                    />
                </>
            )}
        </div>
    );
}
