import { NodeSelection } from '@tiptap/pm/state';
import type { NodeViewProps } from '@tiptap/react';
import { ReactNodeViewRenderer } from '@tiptap/react';
import type { FigureAttrs } from '@workspace/lib/docs/eigendoc';
import { FigureNode, readFigureFrameAttrs, setFigureAttributes } from '@workspace/lib/docs/eigendoc';
import { useMediaResolver } from '@workspace/lib/drive';
import type { Box } from '@workspace/lib/vector';
import { ImagePlaceholder } from '@workspace/ui/components/media/image-placeholder';
import { cn } from '@workspace/ui/lib/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    clampFigureWidth,
    FigureFrame,
    type FigureFrameOptions,
    figureFramePlugins,
    figureMaxWidth,
    useFigureResize,
} from './figure-frame';

// The width a figure draws at when neither it nor its page gives one (px).
const FIGURE_DEFAULT_WIDTH = 400;
// What Shift and each arrow key do to a selected figure's width (px).
const FIGURE_RESIZE_STEPS = { ArrowLeft: -10, ArrowRight: 10, ArrowUp: 10, ArrowDown: -10 };
const FIGURE_RESIZE_KEYS = Object.keys(FIGURE_RESIZE_STEPS)
    .map((key) => `Shift+${key}`)
    .join(' ');

const fitFigureWidth = (next: Box, maxWidth: number) => clampFigureWidth(next.width, maxWidth);

function FigureView(props: NodeViewProps) {
    const { node, selected, editor, getPos } = props;
    const imageRef = useRef<HTMLImageElement>(null);
    const containerRef = useRef<HTMLSpanElement>(null);
    const [aspectRatio, setAspectRatio] = useState<number | null>(null);
    const [failedSrc, setFailedSrc] = useState<string | null>(null);
    const imageProcessed = useRef(false);

    const { resolveMediaUrl, isMediaMissing } = useMediaResolver();

    const setAttributes = useCallback(
        (attributes: FigureAttrs) =>
            editor.commands.command(({ tr }) => {
                const pos = getPos();
                if (pos === undefined) return false;
                setFigureAttributes(tr, pos, attributes);
                return true;
            }),
        [editor, getPos],
    );

    const width = node.attrs.width;
    const mediaName: string = node.attrs.mediaName ?? '';
    const src = resolveMediaUrl(mediaName) || node.attrs.src || '';
    const showPlaceholder = !src;
    const alt = node.attrs.alt || '';
    const isEditable = editor.isEditable;
    const layout = readFigureFrameAttrs(node.attrs).layout ?? 'block';

    // Re-arm the one-shot loader when the source changes so the author's width reset recomputes the ratio.
    useEffect(() => {
        imageProcessed.current = false;
        setAspectRatio(null);
    }, [mediaName]);

    const getMaxWidth = useCallback(() => figureMaxWidth(containerRef.current, layout), [layout]);
    const commitWidth = useCallback((next: number) => setAttributes({ width: next }), [setAttributes]);
    const resize = useFigureResize({ getMaxWidth, fit: fitFigureWidth, commit: commitWidth });

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
                setAttributes({ width: Math.round(Math.min(nw, maxWidth)) });
            }
            return;
        }

        // SVGs without explicit dimensions report 0x0 — set a width, then read
        // the rendered aspect ratio after the browser lays out using the viewBox
        if (!node.attrs.width) {
            setAttributes({ width: Math.round(maxWidth === Infinity ? FIGURE_DEFAULT_WIDTH : maxWidth) });
        }
        requestAnimationFrame(() => {
            if (!imageRef.current) return;
            const w = imageRef.current.clientWidth;
            const h = imageRef.current.clientHeight;
            if (w > 0 && h > 0) setAspectRatio(w / h);
        });
    }, [getMaxWidth, node.attrs.width, setAttributes]);

    const displayWidth = resize.preview ?? width;
    // A picture no browser draws (WMF, EMF) shows its alt text, which a small width squeezes, so its box takes 10rem,
    // or all its container gives: a fixed minimum would push a narrow table cell wider. The wrapper takes it too, as a
    // wrapped figure floats and shrinks to fit. With no alt text the image would draw 0 px tall, so it keeps a line.
    const failed = failedSrc === src;
    // Mount the shared transform chrome only once we have a resolvable px box (loaded, sized,
    // editable, not a pending placeholder). Otherwise a selected figure shows the plain ring.
    // Height derives from the ratio: the figure stores width only.
    const box: Box | null =
        selected && isEditable && !showPlaceholder && aspectRatio && displayWidth
            ? { x: 0, y: 0, width: displayWidth, height: displayWidth / aspectRatio, angle: 0 }
            : null;

    return (
        <FigureFrame
            {...props}
            containerRef={containerRef}
            box={box}
            resizeMode="aspect"
            onTransform={resize.onTransform}
            onCommit={resize.onCommit}
            onGestureEnd={resize.onGestureEnd}
            label="Resize image"
            keyShortcuts={FIGURE_RESIZE_KEYS}
            className={cn(failed && 'min-w-[min(10rem,100%)]')}
        >
            {showPlaceholder ? (
                <div style={{ width: `${displayWidth || FIGURE_DEFAULT_WIDTH}px`, aspectRatio: '16 / 10' }}>
                    <ImagePlaceholder missing={isMediaMissing(mediaName)} />
                </div>
            ) : (
                <img
                    ref={imageRef}
                    src={src}
                    alt={alt}
                    className={cn('max-w-full block', failed && 'min-w-full min-h-10 bg-muted')}
                    style={{
                        width: displayWidth ? `${displayWidth}px` : undefined,
                        aspectRatio: aspectRatio ?? undefined,
                    }}
                    onLoad={handleImageLoad}
                    onError={() => setFailedSrc(src)}
                    draggable={false}
                    decoding="async"
                />
            )}
        </FigureFrame>
    );
}

export const Figure = FigureNode.extend<FigureFrameOptions>({
    addOptions() {
        return { onContextMenu: () => {}, onOpenComment: () => {} };
    },
    addKeyboardShortcuts() {
        // Shift+Arrow would extend the selection from the figure; on a selected figure it resizes instead.
        const resize = (delta: number) => () => {
            const { selection } = this.editor.state;
            if (
                !(selection instanceof NodeSelection) ||
                selection.node.type.name !== this.name ||
                !this.editor.isEditable
            )
                return false;
            const figure = this.editor.view.nodeDOM(selection.from);
            const maxWidth = figureMaxWidth(figure, selection.node.attrs.layout);
            // With no width stored, the image draws at its own width, and a placeholder at the default.
            const drawn =
                (figure instanceof Element && figure.querySelector('img')?.clientWidth) || FIGURE_DEFAULT_WIDTH;
            return this.editor.commands.updateFigure({
                width: clampFigureWidth((selection.node.attrs.width || drawn) + delta, maxWidth),
            });
        };
        return Object.fromEntries(
            Object.entries(FIGURE_RESIZE_STEPS).map(([key, step]) => [`Shift-${key}`, resize(step)]),
        );
    },
    addProseMirrorPlugins() {
        return figureFramePlugins(this.name);
    },
    addNodeView() {
        // TipTap skips the re-render when only decorations change, and the comment mark's color
        // arrives as one.
        return ReactNodeViewRenderer(FigureView, {
            update: ({ updateProps }) => {
                updateProps();
                return true;
            },
        });
    },
});
