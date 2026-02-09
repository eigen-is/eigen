import {useCallback, useEffect, useRef, useState} from "react";
import {cn} from "@workspace/ui/lib/utils";
import {type MediaStyleOptions, type ResizableMediaProps, defaultStyleOptions} from "./media.types";

type ResizeHandle = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se';

const borderRadiusMap: Record<MediaStyleOptions['borderRadius'], string> = {
    none: 'rounded-none',
    sm: 'rounded-sm',
    md: 'rounded-md',
    lg: 'rounded-lg',
    xl: 'rounded-xl',
    full: 'rounded-full',
};

const shadowMap: Record<MediaStyleOptions['shadow'], string> = {
    none: '',
    sm: 'shadow-sm',
    md: 'shadow-md',
    lg: 'shadow-lg',
    xl: 'shadow-xl',
};

export function ResizableMedia({
    src,
    alt = "",
    width,
    minWidth = 50,
    isSelected,
    styleOptions = defaultStyleOptions,
    onWidthChange,
    onSelect,
    onDeselect,
    onDelete,
}: ResizableMediaProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const imageRef = useRef<HTMLImageElement>(null);
    const [isResizing, setIsResizing] = useState(false);
    const [aspectRatio, setAspectRatio] = useState<number | null>(null);

    const handleImageLoad = useCallback(() => {
        if (imageRef.current && aspectRatio === null) {
            const ratio = imageRef.current.naturalWidth / imageRef.current.naturalHeight;
            setAspectRatio(ratio);
        }
    }, [aspectRatio]);

    const handleResizeStart = useCallback((e: React.MouseEvent, handle: ResizeHandle) => {
        e.preventDefault();
        e.stopPropagation();
        if (!aspectRatio) return;

        setIsResizing(true);
        const startX = e.clientX;
        const startY = e.clientY;
        const startWidth = imageRef.current?.offsetWidth || width || 300;

        const handleMouseMove = (moveEvent: MouseEvent) => {
            const deltaX = moveEvent.clientX - startX;
            const deltaY = moveEvent.clientY - startY;
            let newWidth: number;

            if (handle === 'n' || handle === 's') {
                const deltaHeight = handle === 'n' ? -deltaY : deltaY;
                newWidth = Math.max(minWidth, startWidth + deltaHeight * aspectRatio!);
            } else if (handle === 'w' || handle === 'e') {
                const effectiveDelta = handle === 'w' ? -deltaX : deltaX;
                newWidth = Math.max(minWidth, startWidth + effectiveDelta);
            } else {
                const isLeft = handle === 'nw' || handle === 'sw';
                const isTop = handle === 'nw' || handle === 'ne';
                const effectiveDeltaX = isLeft ? -deltaX : deltaX;
                const effectiveDeltaY = isTop ? -deltaY : deltaY;
                const deltaFromY = effectiveDeltaY * aspectRatio!;
                const avgDelta = (effectiveDeltaX + deltaFromY) / 2;
                newWidth = Math.max(minWidth, startWidth + avgDelta);
            }
            onWidthChange(Math.round(newWidth));
        };

        const handleMouseUp = () => {
            setIsResizing(false);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }, [width, minWidth, aspectRatio, onWidthChange]);

    const handleClick = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        if (!isSelected) {
            onSelect();
        }
    }, [isSelected, onSelect]);

    useEffect(() => {
        if (!isSelected) return;

        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                onDeselect();
            }
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onDeselect();
            } else if ((e.key === 'Delete' || e.key === 'Backspace') && onDelete) {
                e.preventDefault();
                onDelete();
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleKeyDown);

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [isSelected, onDeselect, onDelete]);

    const radius = borderRadiusMap[styleOptions.borderRadius];
    const shadow = shadowMap[styleOptions.shadow];

    return (
        <div
            ref={containerRef}
            className="relative inline-block"
            onClick={handleClick}
            style={{cursor: isResizing ? 'grabbing' : 'pointer'}}
        >
            <img
                ref={imageRef}
                src={src}
                alt={alt}
                className={cn("max-w-full block", radius, shadow)}
                style={{
                    width: width ? `${width}px` : undefined,
                    aspectRatio: aspectRatio ?? undefined,
                }}
                onLoad={handleImageLoad}
                draggable={false}
            />
            {isSelected && (
                <>
                    <div className={cn(
                        "absolute inset-0 border-2 border-dashed border-blue-500 bg-blue-500/10 pointer-events-none",
                        radius
                    )} />
                    <ResizeHandle position="nw" onMouseDown={(e) => handleResizeStart(e, 'nw')} />
                    <ResizeHandle position="n" onMouseDown={(e) => handleResizeStart(e, 'n')} />
                    <ResizeHandle position="ne" onMouseDown={(e) => handleResizeStart(e, 'ne')} />
                    <ResizeHandle position="w" onMouseDown={(e) => handleResizeStart(e, 'w')} />
                    <ResizeHandle position="e" onMouseDown={(e) => handleResizeStart(e, 'e')} />
                    <ResizeHandle position="sw" onMouseDown={(e) => handleResizeStart(e, 'sw')} />
                    <ResizeHandle position="s" onMouseDown={(e) => handleResizeStart(e, 's')} />
                    <ResizeHandle position="se" onMouseDown={(e) => handleResizeStart(e, 'se')} />
                </>
            )}
        </div>
    );
}

type ResizeHandleProps = {
    position: ResizeHandle;
    onMouseDown: (e: React.MouseEvent) => void;
};

const cursorMap: Record<ResizeHandle, string> = {
    nw: 'nwse-resize',
    n: 'ns-resize',
    ne: 'nesw-resize',
    w: 'ew-resize',
    e: 'ew-resize',
    sw: 'nesw-resize',
    s: 'ns-resize',
    se: 'nwse-resize',
};

const positionMap: Record<ResizeHandle, string> = {
    nw: 'top-0 left-0 -translate-x-1/2 -translate-y-1/2',
    n: 'top-0 left-1/2 -translate-x-1/2 -translate-y-1/2',
    ne: 'top-0 right-0 translate-x-1/2 -translate-y-1/2',
    w: 'top-1/2 left-0 -translate-x-1/2 -translate-y-1/2',
    e: 'top-1/2 right-0 translate-x-1/2 -translate-y-1/2',
    sw: 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2',
    s: 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2',
    se: 'bottom-0 right-0 translate-x-1/2 translate-y-1/2',
};

function ResizeHandle({position, onMouseDown}: ResizeHandleProps) {
    return (
        <div
            className={cn(
                "absolute size-2 bg-white border border-blue-500 rounded-sm",
                positionMap[position]
            )}
            style={{cursor: cursorMap[position]}}
            onMouseDown={onMouseDown}
        />
    );
}
