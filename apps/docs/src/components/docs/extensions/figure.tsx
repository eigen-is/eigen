import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { FigureLayout } from '@workspace/lib/docs/eigendoc';
import { FigureNode } from '@workspace/lib/docs/eigendoc';
import { isPendingMediaName, useMediaResolver } from '@workspace/lib/drive';
import { ImagePlaceholder } from '@workspace/ui/components/layout/media/image-placeholder';
import { ImageResizeHandles } from '@workspace/ui/components/layout/media/image-resize-handles';
import { cn } from '@workspace/ui/lib/utils';
import { useCallback, useEffect, useRef, useState } from 'react';

function FigureView({ node, updateAttributes, selected, editor }: NodeViewProps) {
    const imageRef = useRef<HTMLImageElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [aspectRatio, setAspectRatio] = useState<number | null>(null);
    const imageProcessed = useRef(false);

    const { resolveMediaUrl } = useMediaResolver();

    const width = node.attrs.width;
    const alignment = node.attrs.alignment || 'center';
    const caption = node.attrs.caption || '';
    const mediaName: string = node.attrs.mediaName ?? '';
    const src = resolveMediaUrl(mediaName) || node.attrs.src || '';
    const showPlaceholder = !src && isPendingMediaName(mediaName);
    const alt = node.attrs.alt || '';
    const isEditable = editor.isEditable;
    const layout = (node.attrs.layout || 'block') as FigureLayout;
    const isWrapping = layout === 'wrap-left' || layout === 'wrap-right';

    // Re-arm the one-shot loader when the source changes so the author's width reset recomputes the ratio.
    useEffect(() => {
        imageProcessed.current = false;
        setAspectRatio(null);
    }, [mediaName]);

    const getMaxWidth = useCallback(() => {
        const container = containerRef.current?.closest('[data-document]');
        if (!container) return Infinity;
        const style = getComputedStyle(container);
        const fullWidth = container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return isWrapping ? fullWidth * 0.5 : fullWidth;
    }, [isWrapping]);

    const handleImageLoad = useCallback(() => {
        if (!imageRef.current || imageProcessed.current) return;

        const nw = imageRef.current.naturalWidth;
        const nh = imageRef.current.naturalHeight;
        const hasIntrinsicSize = nw > 0 && nh > 0;
        // Intrinsic dimensions need no layout, so the resize handles get their ratio even from a load
        // that happens while the editor is hidden.
        if (hasIntrinsicSize) setAspectRatio(nw / nh);

        const maxWidth = getMaxWidth();
        // A hidden editor measures 0 while the padding subtracts, and that negative width would land in
        // the doc. Load fires once per src, so un-hiding brings no second chance: the width stays unset
        // until the node view remounts, which max-w-full renders fine.
        if (maxWidth <= 0) return;
        imageProcessed.current = true;

        if (hasIntrinsicSize) {
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

    const alignmentClass = isWrapping
        ? ''
        : alignment === 'center'
          ? 'items-center'
          : alignment === 'right'
            ? 'items-end'
            : 'items-start';

    const wrapperStyle: React.CSSProperties = {
        cursor: isEditable ? 'grab' : undefined,
        ...(layout === 'wrap-left'
            ? { float: 'left', margin: '0.25em 1em 0.5em 0' }
            : layout === 'wrap-right'
              ? { float: 'right', margin: '0.25em 0 0.5em 1em' }
              : undefined),
    };

    return (
        <NodeViewWrapper
            as="span"
            className={cn('flex flex-col', alignmentClass)}
            data-drag-handle=""
            draggable={isEditable}
            style={wrapperStyle}
        >
            <figure className="m-0">
                <div ref={containerRef}>
                    <ImageResizeHandles
                        width={width}
                        aspectRatio={aspectRatio}
                        getMaxWidth={getMaxWidth}
                        onResize={(w) => updateAttributes({ width: w })}
                        selected={selected}
                        editable={isEditable}
                    >
                        {showPlaceholder ? (
                            <div style={{ width: width ? `${width}px` : '400px', aspectRatio: '16 / 10' }}>
                                <ImagePlaceholder />
                            </div>
                        ) : (
                            <img
                                ref={imageRef}
                                src={src}
                                alt={alt}
                                className={cn('max-w-full block', selected && 'ring-2 ring-ring rounded-sm')}
                                style={{
                                    width: width ? `${width}px` : undefined,
                                    aspectRatio: aspectRatio ?? undefined,
                                }}
                                onLoad={handleImageLoad}
                                draggable={false}
                                decoding="async"
                            />
                        )}
                    </ImageResizeHandles>
                    {caption && <figcaption>{caption}</figcaption>}
                </div>
            </figure>
        </NodeViewWrapper>
    );
}

export const Figure = FigureNode.extend({
    addNodeView() {
        return ReactNodeViewRenderer(FigureView);
    },
});
