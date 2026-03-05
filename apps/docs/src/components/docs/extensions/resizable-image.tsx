import {Node, mergeAttributes, type CommandProps} from '@tiptap/core';
import {ReactNodeViewRenderer, NodeViewWrapper} from '@tiptap/react';
import {useCallback, useRef, useState} from 'react';
import type {NodeViewProps} from '@tiptap/react';
import {AlignCenter, AlignLeft, AlignRight} from 'lucide-react';
import {TooltipButton} from '@workspace/ui';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        resizableImage: {
            setResizableImage: (options: {src: string; alt?: string; title?: string; width?: number}) => ReturnType;
        };
    }
}

function ResizableImageView({node, updateAttributes, selected, editor}: NodeViewProps) {
    const imageRef = useRef<HTMLImageElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [, setIsResizing] = useState(false);
    const [localWidth, setLocalWidth] = useState<number | null>(null);
    const [aspectRatio, setAspectRatio] = useState<number | null>(null);

    const width = node.attrs.width;
    const alignment = node.attrs.alignment || 'center';
    const src = node.attrs.src;
    const alt = node.attrs.alt || '';

    const getMaxWidth = useCallback(() => {
        const container = wrapperRef.current?.closest('[data-document]');
        if (!container) return Infinity;
        const style = getComputedStyle(container);
        return container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    }, []);

    const handleImageLoad = useCallback(() => {
        if (imageRef.current && aspectRatio === null) {
            const ratio = imageRef.current.naturalWidth / imageRef.current.naturalHeight;
            setAspectRatio(ratio);

            const naturalWidth = imageRef.current.naturalWidth;
            const maxWidth = getMaxWidth();
            if (!node.attrs.width && naturalWidth > maxWidth) {
                updateAttributes({width: Math.round(maxWidth)});
            }
        }
    }, [aspectRatio, getMaxWidth, node.attrs.width, updateAttributes]);

    const handleResizeStart = useCallback((e: React.MouseEvent, direction: string) => {
        e.preventDefault();
        e.stopPropagation();
        if (!aspectRatio) return;

        setIsResizing(true);
        const startX = e.clientX;
        const startWidth = imageRef.current?.offsetWidth || width || 300;
        const maxWidth = getMaxWidth();
        let currentWidth = startWidth;

        const handleMouseMove = (moveEvent: MouseEvent) => {
            const deltaX = moveEvent.clientX - startX;
            const isLeft = direction === 'w' || direction === 'nw' || direction === 'sw';
            const effectiveDelta = isLeft ? -deltaX : deltaX;
            currentWidth = Math.min(maxWidth, Math.max(100, startWidth + effectiveDelta));
            setLocalWidth(Math.round(currentWidth));
        };

        const handleMouseUp = () => {
            setIsResizing(false);
            setLocalWidth(null);
            updateAttributes({width: Math.round(currentWidth)});
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }, [width, aspectRatio, updateAttributes, getMaxWidth]);

    const displayWidth = localWidth ?? width;
    const isEditable = editor.isEditable;

    return (
        <NodeViewWrapper
            ref={wrapperRef}
            className={`flex ${alignment === 'center' ? 'justify-center' : alignment === 'right' ? 'justify-end' : 'justify-start'}`}
            data-drag-handle=""
            draggable={isEditable}
            style={{cursor: isEditable ? 'grab' : undefined}}
        >
            <div
                className="relative inline-block group"
                style={{width: displayWidth ? `${displayWidth}px` : undefined}}
            >
                <img
                    ref={imageRef}
                    src={src}
                    alt={alt}
                    className={`max-w-full block ${selected ? 'border border-blue-500' : ''}`}
                    style={{
                        width: displayWidth ? `${displayWidth}px` : undefined,
                        aspectRatio: aspectRatio ?? undefined,
                    }}
                    onLoad={handleImageLoad}
                    draggable={false}
                />
                {selected && isEditable && (
                    <>
                        <div className="absolute -top-9 left-1/2 -translate-x-1/2 z-10 flex gap-0.5 bg-white rounded-md shadow-md border p-0.5">
                            <TooltipButton
                                icon={AlignLeft}
                                tooltipText="Align left"
                                active={alignment === 'left'}
                                preventFocusLoss
                                className="h-7 w-7"
                                onClick={() => updateAttributes({alignment: 'left'})}
                            />
                            <TooltipButton
                                icon={AlignCenter}
                                tooltipText="Align center"
                                active={alignment === 'center'}
                                preventFocusLoss
                                className="h-7 w-7"
                                onClick={() => updateAttributes({alignment: 'center'})}
                            />
                            <TooltipButton
                                icon={AlignRight}
                                tooltipText="Align right"
                                active={alignment === 'right'}
                                preventFocusLoss
                                className="h-7 w-7"
                                onClick={() => updateAttributes({alignment: 'right'})}
                            />
                        </div>
                        {/* Resize handles */}
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
        </NodeViewWrapper>
    );
}

export const ResizableImage = Node.create({
    name: 'resizableImage',

    group: 'block',

    atom: true,

    draggable: true,

    addAttributes() {
        return {
            src: {default: null},
            alt: {default: null},
            title: {default: null},
            width: {default: null},
            alignment: {default: 'center'},
        };
    },

    parseHTML() {
        return [{tag: 'img[src]'}];
    },

    renderHTML({HTMLAttributes}) {
        return ['img', mergeAttributes(HTMLAttributes)];
    },

    addNodeView() {
        return ReactNodeViewRenderer(ResizableImageView);
    },

    addCommands() {
        return {
            setResizableImage: (options) => ({commands}: CommandProps) => {
                return commands.insertContent({
                    type: this.name,
                    attrs: options,
                });
            },
        };
    },
});
