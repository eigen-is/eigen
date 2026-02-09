import {useCallback, useEffect, useRef, useState} from "react";
import {ReactEditor, useSlateStatic} from "slate-react";
import {Transforms} from "slate";
import {CustomElement} from "./editor.types";

type ResizeHandle = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se';

type ResizableImageProps = {
    element: CustomElement;
    src: string;
    isSelected: boolean;
    onSelect: () => void;
    onDeselect: () => void;
}

export function ResizableImage({element, src, isSelected, onSelect, onDeselect}: ResizableImageProps) {
    const editor = useSlateStatic();
    const containerRef = useRef<HTMLDivElement>(null);
    const imageRef = useRef<HTMLImageElement>(null);
    const [isResizing, setIsResizing] = useState(false);
    const [aspectRatio, setAspectRatio] = useState<number | null>(null);

    const width = element.width;

    const handleImageLoad = useCallback(() => {
        if (imageRef.current && aspectRatio === null) {
            const nat = imageRef.current.naturalWidth / imageRef.current.naturalHeight;
            setAspectRatio(nat);
        }
    }, [aspectRatio]);

    const updateWidth = useCallback((newWidth: number) => {
        const path = ReactEditor.findPath(editor, element);
        Transforms.setNodes(editor, {width: Math.round(newWidth)}, {at: path});
    }, [editor, element]);

    const handleResizeStart = useCallback((e: React.MouseEvent, handle: ResizeHandle) => {
        e.preventDefault();
        e.stopPropagation();
        if (!aspectRatio) return;
        setIsResizing(true);

        const startX = e.clientX;
        const startWidth = imageRef.current?.offsetWidth || width || 300;

        const handleMouseMove = (moveEvent: MouseEvent) => {
            const deltaX = moveEvent.clientX - startX;
            let newWidth: number;
            
            if (handle === 'w' || handle === 'nw' || handle === 'sw') {
                newWidth = Math.max(50, startWidth - deltaX);
            } else {
                newWidth = Math.max(50, startWidth + deltaX);
            }
            updateWidth(newWidth);
        };

        const handleMouseUp = () => {
            setIsResizing(false);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }, [width, aspectRatio, updateWidth]);

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
            if (e.key === 'Delete' || e.key === 'Backspace' || (e.key.length === 1 && !e.ctrlKey && !e.metaKey)) {
                e.preventDefault();
                const path = ReactEditor.findPath(editor, element);
                Transforms.removeNodes(editor, {at: path});
                onDeselect();
            } else if (e.key === 'Escape') {
                onDeselect();
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleKeyDown);

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [isSelected, editor, element, onDeselect]);

    const handleStyle: React.CSSProperties = {
        position: 'absolute',
        width: 8,
        height: 8,
        backgroundColor: 'white',
        border: '1px solid #3b82f6',
        borderRadius: 2,
    };

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
                alt=""
                className="max-w-full rounded block"
                style={{
                    width: width ? `${width}px` : undefined,
                    aspectRatio: aspectRatio ?? undefined,
                }}
                onLoad={handleImageLoad}
                draggable={false}
            />
            {isSelected && (
                <>
                    <div
                        className="absolute inset-0 border-2 border-dashed border-blue-500 bg-blue-500/10 pointer-events-none rounded"
                    />
                    <div style={{...handleStyle, top: -4, left: -4, cursor: 'nwse-resize'}}
                         onMouseDown={(e) => handleResizeStart(e, 'nw')}/>
                    <div style={{...handleStyle, top: -4, left: '50%', transform: 'translateX(-50%)', cursor: 'ns-resize'}}
                         onMouseDown={(e) => handleResizeStart(e, 'n')}/>
                    <div style={{...handleStyle, top: -4, right: -4, cursor: 'nesw-resize'}}
                         onMouseDown={(e) => handleResizeStart(e, 'ne')}/>
                    <div style={{...handleStyle, top: '50%', left: -4, transform: 'translateY(-50%)', cursor: 'ew-resize'}}
                         onMouseDown={(e) => handleResizeStart(e, 'w')}/>
                    <div style={{...handleStyle, top: '50%', right: -4, transform: 'translateY(-50%)', cursor: 'ew-resize'}}
                         onMouseDown={(e) => handleResizeStart(e, 'e')}/>
                    <div style={{...handleStyle, bottom: -4, left: -4, cursor: 'nesw-resize'}}
                         onMouseDown={(e) => handleResizeStart(e, 'sw')}/>
                    <div style={{...handleStyle, bottom: -4, left: '50%', transform: 'translateX(-50%)', cursor: 'ns-resize'}}
                         onMouseDown={(e) => handleResizeStart(e, 's')}/>
                    <div style={{...handleStyle, bottom: -4, right: -4, cursor: 'nwse-resize'}}
                         onMouseDown={(e) => handleResizeStart(e, 'se')}/>
                </>
            )}
        </div>
    );
}
