import {useCallback, useEffect, useRef, useState} from "react";
import {cn} from "@workspace/ui/lib/utils";
import {Popover, PopoverContent, PopoverTrigger} from "@workspace/ui/components/popover";
import {Button} from "@workspace/ui/components/button";
import {Palette, AlignLeft, AlignCenter, AlignRight} from "lucide-react";
import {type MediaStyleOptions, type MediaAlignment, type ResizableMediaProps, defaultStyleOptions} from "./media.types";
import {MediaStylePicker} from "./media-style-picker";

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

const alignmentStyles: Record<MediaAlignment, React.CSSProperties> = {
    left: {float: 'left', margin: '0 1rem 1rem 0'},
    center: {display: 'flex', justifyContent: 'center', width: '100%'},
    right: {float: 'right', margin: '0 0 1rem 1rem'},
};

export function ResizableMedia({
    src,
    alt = "",
    width,
    minWidth = 50,
    isSelected,
    alignment = 'center',
    styleOptions = defaultStyleOptions,
    onWidthChange,
    onAlignmentChange,
    onStyleChange,
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
            const target = e.target as HTMLElement;
            const isInsideContainer = containerRef.current?.contains(target);
            const isInsidePopover = target.closest('[data-radix-popper-content-wrapper]');
            if (!isInsideContainer && !isInsidePopover) {
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
    const border = styleOptions.border ? 'ring-1 ring-border' : '';
    const alignStyle = alignmentStyles[alignment];

    return (
        <div
            ref={containerRef}
            className="relative inline-block"
            onClick={handleClick}
            style={{
                cursor: isResizing ? 'grabbing' : 'pointer',
                ...alignStyle,
            }}
        >
            <img
                ref={imageRef}
                src={src}
                alt={alt}
                className={cn("max-w-full block", radius, shadow, border)}
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
                    {(onStyleChange || onAlignmentChange) && (
                        <div className="absolute -top-10 left-1/2 -translate-x-1/2 z-10 flex gap-1 bg-background rounded-md shadow-md border p-1">
                            {onAlignmentChange && (
                                <>
                                    <Button
                                        size="icon"
                                        variant={alignment === 'left' ? 'default' : 'ghost'}
                                        className="size-7"
                                        onClick={() => onAlignmentChange('left')}
                                    >
                                        <AlignLeft className="size-4" />
                                    </Button>
                                    <Button
                                        size="icon"
                                        variant={alignment === 'center' ? 'default' : 'ghost'}
                                        className="size-7"
                                        onClick={() => onAlignmentChange('center')}
                                    >
                                        <AlignCenter className="size-4" />
                                    </Button>
                                    <Button
                                        size="icon"
                                        variant={alignment === 'right' ? 'default' : 'ghost'}
                                        className="size-7"
                                        onClick={() => onAlignmentChange('right')}
                                    >
                                        <AlignRight className="size-4" />
                                    </Button>
                                </>
                            )}
                            {onStyleChange && (
                                <Popover>
                                    <PopoverTrigger asChild>
                                        <Button size="icon" variant="ghost" className="size-7">
                                            <Palette className="size-4" />
                                        </Button>
                                    </PopoverTrigger>
                                    <PopoverContent align="center" className="w-auto p-0">
                                        <MediaStylePicker value={styleOptions} onChange={onStyleChange} />
                                    </PopoverContent>
                                </Popover>
                            )}
                        </div>
                    )}
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
