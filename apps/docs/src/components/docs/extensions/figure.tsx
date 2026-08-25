import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { FigureLayout } from '@workspace/lib/docs/eigendoc';
import { FigureNode } from '@workspace/lib/docs/eigendoc';
import { isPendingMediaName, useMediaResolver } from '@workspace/lib/drive';
import type { Box } from '@workspace/lib/vector';
import { ImagePlaceholder } from '@workspace/ui/components/media/image-placeholder';
import { ObjectTransform } from '@workspace/ui/components/transform/object-transform';
import { cn } from '@workspace/ui/lib/utils';
import { useCallback, useEffect, useRef, useState } from 'react';

// The figure's resize floor (px).
const FIGURE_MIN_WIDTH = 100;

function FigureView({ node, updateAttributes, selected, editor }: NodeViewProps) {
    const imageRef = useRef<HTMLImageElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [aspectRatio, setAspectRatio] = useState<number | null>(null);
    const imageProcessed = useRef(false);
    // Live preview width during an ObjectTransform drag — never a node write until onCommit.
    const [previewWidth, setPreviewWidth] = useState<number | null>(null);
    // First onTransform of a gesture is the de-facto start (ObjectTransform has no onStart): latch
    // it so getMaxWidth is measured ONCE per drag (a forced layout is too costly per move).
    const transformStarted = useRef(false);
    const gestureMaxWidth = useRef(Number.POSITIVE_INFINITY);

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

    // Safety net: ObjectTransform's Escape-cancel and no-move-click paths fire no onCommit, so a
    // leftover preview width would otherwise stick. Any pointerup drops it and re-arms the latch.
    // Scoped to the transform-chrome window (selected + editable) so at most one figure in the
    // document holds these global listeners; teardown also clears, so a deselect mid-gesture can't
    // strand a stale preview.
    useEffect(() => {
        if (!(selected && isEditable)) return;
        const clear = () => {
            transformStarted.current = false;
            setPreviewWidth((p) => (p === null ? p : null));
        };
        document.addEventListener('pointerup', clear);
        document.addEventListener('pointercancel', clear);
        return () => {
            document.removeEventListener('pointerup', clear);
            document.removeEventListener('pointercancel', clear);
            clear();
        };
    }, [selected, isEditable]);

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

    // ObjectTransform seam. The figure is a DOM box in screen space, so scene units ARE screen px:
    // the ring insets over the img (shrink-wrapped by the relative wrapper) and the pointer delta is
    // an identity mapping. Height derives from the ratio — the figure stores width only.
    const boxToStyle = useCallback((): React.CSSProperties => ({ inset: 0 }), []);
    const screenDeltaToScene = useCallback((dx: number, dy: number) => ({ dx, dy }), []);

    const handleTransform = useCallback(
        (next: Box) => {
            if (!transformStarted.current) {
                transformStarted.current = true;
                // Measured once per gesture (see latch note); a hidden surface reports <=0, which the
                // FIGURE_MIN_WIDTH floor below wins over.
                gestureMaxWidth.current = getMaxWidth();
            }
            const w = Math.max(FIGURE_MIN_WIDTH, Math.min(gestureMaxWidth.current, next.width));
            setPreviewWidth(Math.round(w));
        },
        [getMaxWidth],
    );

    const handleCommit = useCallback(
        (next: Box) => {
            const w = Math.max(FIGURE_MIN_WIDTH, Math.min(gestureMaxWidth.current, next.width));
            transformStarted.current = false;
            setPreviewWidth(null);
            updateAttributes({ width: Math.round(w) });
        },
        [updateAttributes],
    );

    // Keyboard resize (accessibility): kept docs-side, wired to the same width write, so
    // ObjectTransform's chrome stays pixel-identical to slides/vector. Tab to the wrapper, arrow to
    // resize; Shift = fine step. Floor/ceiling mirror the pointer path.
    const handleKeyResize = useCallback(
        (e: React.KeyboardEvent) => {
            const step = e.shiftKey ? 1 : 10;
            const delta =
                e.key === 'ArrowRight' || e.key === 'ArrowUp'
                    ? step
                    : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
                      ? -step
                      : 0;
            if (delta === 0) return;
            e.preventDefault();
            e.stopPropagation();
            const next = Math.max(FIGURE_MIN_WIDTH, Math.min(getMaxWidth(), (width || 300) + delta));
            updateAttributes({ width: Math.round(next) });
        },
        [getMaxWidth, width, updateAttributes],
    );

    const displayWidth = previewWidth ?? width;
    // Mount the shared transform chrome only once we have a resolvable px box (loaded, sized,
    // editable, not a pending placeholder). Otherwise a selected figure shows the plain ring.
    const box: Box | null =
        selected && isEditable && !showPlaceholder && aspectRatio && displayWidth
            ? { x: 0, y: 0, width: displayWidth, height: displayWidth / aspectRatio, angle: 0 }
            : null;

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
                    {/* Relative wrapper shrink-wraps the img so the inset-0 ObjectTransform ring
                        lands exactly on the image box. When no transform mounts (placeholder,
                        read-only, pre-load), the same ring shows via the class. */}
                    <div
                        className={cn('relative inline-block', selected && !box && 'eigen-selection-ring')}
                        tabIndex={selected && isEditable ? 0 : undefined}
                        aria-label={selected && isEditable ? 'Resize image' : undefined}
                        onKeyDown={selected && isEditable ? handleKeyResize : undefined}
                        // A body click must not move DOM focus out of ProseMirror onto this tabIndex
                        // wrapper (the deleted component's grips preventDefault'd for the same
                        // reason); Tab-focus for keyboard resize is unaffected. Scoped to exactly
                        // when the wrapper is focusable: the figure node is draggable, and a
                        // prevented mousedown suppresses native drag start in spec-following
                        // browsers — with no tabIndex there is no steal, so an unselected (or
                        // read-only) figure's press stays fully native for PM click-select + drag.
                        onMouseDown={selected && isEditable ? (e) => e.preventDefault() : undefined}
                    >
                        {showPlaceholder ? (
                            <div
                                style={{ width: displayWidth ? `${displayWidth}px` : '400px', aspectRatio: '16 / 10' }}
                            >
                                <ImagePlaceholder />
                            </div>
                        ) : (
                            <img
                                ref={imageRef}
                                src={src}
                                alt={alt}
                                className="max-w-full block"
                                style={{
                                    width: displayWidth ? `${displayWidth}px` : undefined,
                                    aspectRatio: aspectRatio ?? undefined,
                                }}
                                onLoad={handleImageLoad}
                                draggable={false}
                                decoding="async"
                            />
                        )}
                        {box && (
                            <ObjectTransform
                                box={box}
                                boxToStyle={boxToStyle}
                                screenDeltaToScene={screenDeltaToScene}
                                showRotate={false}
                                resizeMode="aspect"
                                // Default minSize (1): in aspect mode the component floors BOTH dims,
                                // which would inflate wide images (a 100 floor on a 4:1 banner's height
                                // forces width 400). The width-only [100, maxWidth] floor is the host
                                // clamp in handleTransform/handleCommit/handleKeyResize.
                                onTransform={handleTransform}
                                onCommit={handleCommit}
                            />
                        )}
                    </div>
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
