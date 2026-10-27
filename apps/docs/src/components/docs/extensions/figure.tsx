// The Docs editor's picture: the shared figure node with a view that resolves its media, draws a placeholder for a
// missing file and resizes inside the figure frame. It draws at its own ratio, or stretched to a stored height, and
// its grips keep that ratio while Keep aspect ratio is on. Shift and an arrow key resize a selected picture too.

import { NodeSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { NodeViewProps } from '@tiptap/react';
import { ReactNodeViewRenderer } from '@tiptap/react';
import type { FigureAttrs } from '@workspace/lib/docs/eigendoc';
import { FigureNode, readFigureAttrs, setFigureAttributes } from '@workspace/lib/docs/eigendoc';
import { useMediaResolver } from '@workspace/lib/drive';
import type { Box } from '@workspace/lib/vector';
import { ImagePlaceholder } from '@workspace/ui/components/media';
import { cn } from '@workspace/ui/lib/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FigureFrameOptions } from './figure-frame';
import {
    aspectLockedIn,
    clampFigureWidth,
    FigureFrame,
    figureFramePlugins,
    figureMaxWidth,
    fitFigureBox,
    useFigureResize,
} from './figure-frame';

// The width a figure draws at when neither it nor its page gives one (px).
const FIGURE_DEFAULT_WIDTH = 400;
// What Shift and each arrow key do to a selected figure's width (px).
const FIGURE_RESIZE_STEPS = { ArrowLeft: -10, ArrowRight: 10, ArrowUp: 10, ArrowDown: -10 };
const FIGURE_RESIZE_KEYS = Object.keys(FIGURE_RESIZE_STEPS)
    .map((key) => `Shift+${key}`)
    .join(' ');

// A picture's own ratio off its <img>: its natural size, or as drawn for an SVG that has none. None before it draws.
export function pictureRatio(view: EditorView, pos: number): number | null {
    const dom = view.nodeDOM(pos);
    const img = dom instanceof Element ? dom.querySelector('img') : null;
    if (!img) return null;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) return img.naturalWidth / img.naturalHeight;
    return img.clientWidth > 0 && img.clientHeight > 0 ? img.clientWidth / img.clientHeight : null;
}

function FigureView(props: NodeViewProps) {
    const { node, selected, editor, getPos, decorations } = props;
    const imageRef = useRef<HTMLImageElement>(null);
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

    const { width, height, layout } = readFigureAttrs(node.attrs);
    const mediaName: string = node.attrs.mediaName ?? '';
    const src = resolveMediaUrl(mediaName) || node.attrs.src || '';
    const showPlaceholder = !src;
    const alt = node.attrs.alt || '';
    const isEditable = editor.isEditable;
    const locked = aspectLockedIn(decorations, 'figure');
    // A stretched picture draws at its stored box, any other at its own ratio.
    const ratio = width && height ? width / height : aspectRatio;

    // Re-arm the one-shot loader when the source changes so the author's width reset recomputes the ratio.
    useEffect(() => {
        imageProcessed.current = false;
        setAspectRatio(null);
    }, [mediaName]);

    const getMaxWidth = useCallback(() => figureMaxWidth(editor, layout), [editor, layout]);
    const fit = useCallback(
        (next: Box, maxWidth: number) => fitFigureBox(next, maxWidth, locked ? ratio : null),
        [locked, ratio],
    );
    // A picture at its own ratio keeps its width alone, so its height follows that ratio wherever it draws. A stretched
    // one, or one an unlocked grip stretches, keeps both sides.
    const stored = useCallback(
        (size: { width: number; height: number }) =>
            locked && !height ? { width: size.width } : { width: size.width, height: Math.round(size.height) },
        [locked, height],
    );
    const resize = useFigureResize({ editor, getPos, node, getMaxWidth, fit, stored });

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
            if (!width) {
                setAttributes({ width: Math.round(Math.min(nw, maxWidth)) });
            }
            return;
        }

        // SVGs without explicit dimensions report 0x0 — set a width, then read
        // the rendered aspect ratio after the browser lays out using the viewBox
        if (!width) {
            setAttributes({ width: Math.round(maxWidth === Infinity ? FIGURE_DEFAULT_WIDTH : maxWidth) });
        }
        requestAnimationFrame(() => {
            if (!imageRef.current) return;
            const w = imageRef.current.clientWidth;
            const h = imageRef.current.clientHeight;
            if (w > 0 && h > 0) setAspectRatio(w / h);
        });
    }, [getMaxWidth, setAttributes, width]);

    const drawn = resize.preview?.size;
    const displayWidth = drawn?.width ?? width;
    const displayRatio = drawn ? drawn.width / drawn.height : ratio;
    // A picture no browser draws (WMF, EMF) shows its alt text, which a small width squeezes, so its box takes 10rem,
    // or all its container gives: a fixed minimum would push a narrow table cell wider. The wrapper takes it too, as a
    // wrapped figure floats and shrinks to fit. With no alt text the image would draw 0 px tall, so it keeps a line.
    const failed = failedSrc === src;
    // Mount the shared transform chrome only once we have a resolvable px box (sized, its ratio known, editable, not a
    // pending placeholder). Otherwise a selected figure shows the plain ring.
    const box: Box | null =
        selected && isEditable && !showPlaceholder && displayRatio && displayWidth
            ? { x: 0, y: 0, width: displayWidth, height: displayWidth / displayRatio, angle: 0 }
            : null;

    return (
        <FigureFrame
            {...props}
            box={box}
            shift={resize.preview?.shift}
            resizeMode={locked ? 'aspect' : 'free'}
            onTransform={resize.onTransform}
            onCommit={resize.onCommit}
            onGestureEnd={resize.onGestureEnd}
            label="Resize image"
            keyShortcuts={FIGURE_RESIZE_KEYS}
            className={cn(failed && 'min-w-[min(10rem,100%)]')}
        >
            {showPlaceholder ? (
                <div style={{ width: `${displayWidth || FIGURE_DEFAULT_WIDTH}px`, aspectRatio: ratio ?? '16 / 10' }}>
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
                        aspectRatio: displayRatio ?? undefined,
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
            const { width: stored, height, layout } = readFigureAttrs(selection.node.attrs);
            // With no width stored, the image draws at its own width, and a placeholder at the default.
            const from =
                stored ??
                ((figure instanceof Element && figure.querySelector('img')?.clientWidth) || FIGURE_DEFAULT_WIDTH);
            const width = clampFigureWidth(from + delta, figureMaxWidth(this.editor, layout));
            // A stretched picture keeps its shape.
            return this.editor.commands.resizeFigure(selection.from, {
                width,
                ...(height && { height: Math.round((height * width) / from) }),
            });
        };
        return Object.fromEntries(
            Object.entries(FIGURE_RESIZE_STEPS).map(([key, step]) => [`Shift-${key}`, resize(step)]),
        );
    },
    addProseMirrorPlugins() {
        return figureFramePlugins('figure');
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
