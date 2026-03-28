import { type CommandProps, mergeAttributes, Node } from '@tiptap/core';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useMediaResolver } from '@workspace/lib/drive';
import { TooltipButton } from '@workspace/ui';
import { ImageResizeHandles } from '@workspace/ui/components/layout/media/image-resize-handles';
import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        resizableImage: {
            setResizableImage: (options: {
                mediaName: string;
                alt?: string;
                title?: string;
                width?: number;
            }) => ReturnType;
        };
    }
}

function ResizableImageView({ node, updateAttributes, selected, editor }: NodeViewProps) {
    const imageRef = useRef<HTMLImageElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [aspectRatio, setAspectRatio] = useState<number | null>(null);

    const { resolveMediaUrl } = useMediaResolver();

    const width = node.attrs.width;
    const alignment = node.attrs.alignment || 'center';
    const src = resolveMediaUrl(node.attrs.mediaName) || node.attrs.src || '';
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
                updateAttributes({ width: Math.round(maxWidth) });
            }
        }
    }, [aspectRatio, getMaxWidth, node.attrs.width, updateAttributes]);

    const isEditable = editor.isEditable;

    return (
        <NodeViewWrapper
            ref={wrapperRef}
            className={`flex ${alignment === 'center' ? 'justify-center' : alignment === 'right' ? 'justify-end' : 'justify-start'}`}
            data-drag-handle=""
            draggable={isEditable}
            style={{ cursor: isEditable ? 'grab' : undefined }}
        >
            <ImageResizeHandles
                width={width}
                aspectRatio={aspectRatio}
                maxWidth={getMaxWidth()}
                onResize={(w) => updateAttributes({ width: w })}
                selected={selected}
                editable={isEditable}
            >
                <img
                    ref={imageRef}
                    src={src}
                    alt={alt}
                    className={`max-w-full block ${selected ? 'border border-ring' : ''}`}
                    style={{
                        width: width ? `${width}px` : undefined,
                        aspectRatio: aspectRatio ?? undefined,
                    }}
                    onLoad={handleImageLoad}
                    draggable={false}
                />
                {selected && isEditable && (
                    <div className="absolute -top-9 left-1/2 -translate-x-1/2 z-10 flex gap-0.5 bg-white rounded-md shadow-md border p-0.5">
                        <TooltipButton
                            icon={AlignLeft}
                            tooltipText="Align left"
                            active={alignment === 'left'}
                            preventFocusLoss
                            className="h-7 w-7"
                            onClick={() => updateAttributes({ alignment: 'left' })}
                        />
                        <TooltipButton
                            icon={AlignCenter}
                            tooltipText="Align center"
                            active={alignment === 'center'}
                            preventFocusLoss
                            className="h-7 w-7"
                            onClick={() => updateAttributes({ alignment: 'center' })}
                        />
                        <TooltipButton
                            icon={AlignRight}
                            tooltipText="Align right"
                            active={alignment === 'right'}
                            preventFocusLoss
                            className="h-7 w-7"
                            onClick={() => updateAttributes({ alignment: 'right' })}
                        />
                    </div>
                )}
            </ImageResizeHandles>
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
            mediaName: { default: null },
            src: { default: null },
            alt: { default: null },
            title: { default: null },
            width: {
                default: null,
                parseHTML: (element: HTMLElement) => {
                    const attr = element.getAttribute('width');
                    if (attr) return parseInt(attr, 10) || null;
                    const styleWidth = element.style.width;
                    if (styleWidth?.endsWith('px')) return parseInt(styleWidth, 10) || null;
                    return null;
                },
            },
            alignment: { default: 'center' },
        };
    },

    parseHTML() {
        return [{ tag: 'img[data-media-name]' }, { tag: 'img[src]' }];
    },

    renderHTML({ HTMLAttributes }) {
        return ['img', mergeAttributes(HTMLAttributes)];
    },

    addNodeView() {
        return ReactNodeViewRenderer(ResizableImageView);
    },

    addCommands() {
        return {
            setResizableImage:
                (options) =>
                ({ commands }: CommandProps) => {
                    return commands.insertContent({
                        type: this.name,
                        attrs: options,
                    });
                },
        };
    },
});
