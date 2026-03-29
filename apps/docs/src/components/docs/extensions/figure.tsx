import { type CommandProps, Node } from '@tiptap/core';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useMediaResolver } from '@workspace/lib/drive';
import { ImageResizeHandles } from '@workspace/ui/components/layout/media/image-resize-handles';
import { useCallback, useRef, useState } from 'react';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        figure: {
            setFigure: (options: { mediaName: string; alt?: string; width?: number; caption?: string }) => ReturnType;
        };
    }
}

function FigureView({ node, updateAttributes, selected, editor }: NodeViewProps) {
    const imageRef = useRef<HTMLImageElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [aspectRatio, setAspectRatio] = useState<number | null>(null);

    const { resolveMediaUrl } = useMediaResolver();

    const width = node.attrs.width;
    const alignment = node.attrs.alignment || 'center';
    const caption = node.attrs.caption || '';
    const src = resolveMediaUrl(node.attrs.mediaName) || node.attrs.src || '';
    const alt = node.attrs.alt || '';
    const isEditable = editor.isEditable;

    const getMaxWidth = useCallback(() => {
        const container = containerRef.current?.closest('[data-document]');
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

    const alignmentClass =
        alignment === 'center' ? 'items-center' : alignment === 'right' ? 'items-end' : 'items-start';

    return (
        <NodeViewWrapper
            as="figure"
            className={`flex flex-col ${alignmentClass}`}
            data-drag-handle=""
            draggable={isEditable}
            style={{ cursor: isEditable ? 'grab' : undefined }}
        >
            <div ref={containerRef}>
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
                        className={`max-w-full block ${selected ? 'ring-2 ring-ring rounded-sm' : ''}`}
                        style={{
                            width: width ? `${width}px` : undefined,
                            aspectRatio: aspectRatio ?? undefined,
                        }}
                        onLoad={handleImageLoad}
                        draggable={false}
                    />
                </ImageResizeHandles>
                {caption && <figcaption>{caption}</figcaption>}
            </div>
        </NodeViewWrapper>
    );
}

export const Figure = Node.create({
    name: 'figure',

    group: 'block',

    atom: true,

    draggable: true,

    addAttributes() {
        return {
            mediaName: { default: null },
            src: { default: null },
            alt: { default: null },
            caption: { default: null },
            width: {
                default: null,
                parseHTML: (element: HTMLElement) => {
                    const img = element.querySelector('img') || element;
                    const attr = img.getAttribute('width');
                    if (attr) return parseInt(attr, 10) || null;
                    const styleWidth = (img as HTMLElement).style?.width;
                    if (styleWidth?.endsWith('px')) return parseInt(styleWidth, 10) || null;
                    return null;
                },
            },
            alignment: { default: 'center' },
        };
    },

    parseHTML() {
        return [
            {
                tag: 'figure',
                getAttrs(dom) {
                    const el = dom as HTMLElement;
                    const img = el.querySelector('img');
                    if (!img) return false;
                    const figcaption = el.querySelector('figcaption');
                    return {
                        src: img.getAttribute('src'),
                        alt: img.getAttribute('alt'),
                        mediaName: img.getAttribute('data-media-name'),
                        caption: figcaption?.textContent || null,
                        alignment: el.getAttribute('data-alignment') || 'center',
                    };
                },
                priority: 60,
            },
            {
                tag: 'img[data-media-name]',
                priority: 51,
                getAttrs(dom) {
                    const el = dom as HTMLElement;
                    return {
                        mediaName: el.getAttribute('data-media-name'),
                        src: el.getAttribute('src'),
                        alt: el.getAttribute('alt'),
                    };
                },
            },
            {
                tag: 'img[src]',
                priority: 50,
                getAttrs(dom) {
                    const el = dom as HTMLElement;
                    return {
                        src: el.getAttribute('src'),
                        alt: el.getAttribute('alt'),
                    };
                },
            },
        ];
    },

    renderHTML({ HTMLAttributes }) {
        const figureAttrs: Record<string, unknown> = {};
        if (HTMLAttributes.alignment && HTMLAttributes.alignment !== 'center') {
            figureAttrs['data-alignment'] = HTMLAttributes.alignment;
        }
        const imgAttrs: Record<string, unknown> = {
            src: HTMLAttributes.src,
            alt: HTMLAttributes.alt,
        };
        if (HTMLAttributes['data-media-name'] || HTMLAttributes.mediaName) {
            imgAttrs['data-media-name'] = HTMLAttributes['data-media-name'] || HTMLAttributes.mediaName;
        }
        if (HTMLAttributes.width) {
            imgAttrs.width = HTMLAttributes.width;
        }

        if (HTMLAttributes.caption) {
            return ['figure', figureAttrs, ['img', imgAttrs], ['figcaption', {}, HTMLAttributes.caption]];
        }
        return ['figure', figureAttrs, ['img', imgAttrs]];
    },

    addNodeView() {
        return ReactNodeViewRenderer(FigureView);
    },

    addCommands() {
        return {
            setFigure:
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
