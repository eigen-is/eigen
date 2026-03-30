import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { FigureNode } from '@workspace/lib/docs/eigendoc';
import { useMediaResolver } from '@workspace/lib/drive';
import { ImageResizeHandles } from '@workspace/ui/components/layout/media/image-resize-handles';
import { useCallback, useRef, useState } from 'react';

function FigureView({ node, updateAttributes, selected, editor }: NodeViewProps) {
    const imageRef = useRef<HTMLImageElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [aspectRatio, setAspectRatio] = useState<number | null>(null);
    const imageProcessed = useRef(false);

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
        if (!imageRef.current || imageProcessed.current) return;
        imageProcessed.current = true;

        const nw = imageRef.current.naturalWidth;
        const nh = imageRef.current.naturalHeight;
        const maxWidth = getMaxWidth();

        if (nw > 0 && nh > 0) {
            setAspectRatio(nw / nh);
            if (!node.attrs.width) {
                updateAttributes({ width: Math.round(Math.min(nw, maxWidth)) });
            }
            return;
        }

        // SVGs without explicit dimensions report 0x0 — set a width, then read
        // the rendered aspect ratio after the browser lays out using the viewBox
        if (!node.attrs.width) {
            updateAttributes({ width: Math.round(maxWidth === Infinity ? 400 : maxWidth) });
        }
        requestAnimationFrame(() => {
            if (!imageRef.current) return;
            const w = imageRef.current.clientWidth;
            const h = imageRef.current.clientHeight;
            if (w > 0 && h > 0) setAspectRatio(w / h);
        });
    }, [getMaxWidth, node.attrs.width, updateAttributes]);

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

export const Figure = FigureNode.extend({
    addNodeView() {
        return ReactNodeViewRenderer(FigureView);
    },
});
