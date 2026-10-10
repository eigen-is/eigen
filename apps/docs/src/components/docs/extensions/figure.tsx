import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { FigureAttrs, FigureLayout } from '@workspace/lib/docs/eigendoc';
import { FigureNode, setFigureAttributes } from '@workspace/lib/docs/eigendoc';
import { useMediaResolver } from '@workspace/lib/drive';
import type { Box } from '@workspace/lib/vector';
import { CommentIndicator } from '@workspace/ui/components/comments';
import { ImagePlaceholder } from '@workspace/ui/components/media/image-placeholder';
import { ObjectTransform } from '@workspace/ui/components/transform/object-transform';
import { cn } from '@workspace/ui/lib/utils';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

// The figure's resize floor (px).
const FIGURE_MIN_WIDTH = 100;
// The width a figure draws at when neither it nor its page gives one (px).
const FIGURE_DEFAULT_WIDTH = 400;
// What Shift and each arrow key do to a selected figure's width (px).
const FIGURE_RESIZE_STEPS = { ArrowLeft: -10, ArrowRight: 10, ArrowUp: 10, ArrowDown: -10 };
const FIGURE_RESIZE_KEYS = Object.keys(FIGURE_RESIZE_STEPS)
    .map((key) => `Shift+${key}`)
    .join(' ');

// The text column, or half of it for a wrapped figure: the widest a resize makes it.
function figureMaxWidth(figure: Node | null, layout: FigureLayout | null) {
    const container = figure instanceof Element ? figure.closest('[data-document]') : null;
    if (!container) return Infinity;
    const style = getComputedStyle(container);
    const fullWidth = container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return layout === 'wrap-left' || layout === 'wrap-right' ? fullWidth * 0.5 : fullWidth;
}

type FigureOptions = {
    // The host decides whether a menu opens, so an image with no rows keeps the browser's own.
    onContextMenu: (node: PMNode, pos: number, event: React.MouseEvent) => void;
    onOpenComment: (cardId: string) => void;
};

function FigureView({ node, selected, editor, extension, getPos, decorations }: NodeViewProps) {
    const { onContextMenu, onOpenComment }: FigureOptions = extension.options;
    const commentCardId: string | null = node.attrs.commentCardId;
    const commentColor: string | undefined = decorations.find((d) => 'commentColor' in d.spec)?.spec.commentColor;
    const imageRef = useRef<HTMLImageElement>(null);
    const containerRef = useRef<HTMLSpanElement>(null);
    const [aspectRatio, setAspectRatio] = useState<number | null>(null);
    const [failedSrc, setFailedSrc] = useState<string | null>(null);
    const imageProcessed = useRef(false);
    // Live preview width during an ObjectTransform drag — never a node write until onCommit.
    const [previewWidth, setPreviewWidth] = useState<number | null>(null);
    // First onTransform of a gesture is the de-facto start (ObjectTransform has no onStart): latch
    // it so getMaxWidth is measured ONCE per drag (a forced layout is too costly per move).
    const transformStarted = useRef(false);
    const gestureMaxWidth = useRef(Number.POSITIVE_INFINITY);

    const { resolveMediaUrl } = useMediaResolver();

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
    const alignment = node.attrs.alignment || 'center';
    const caption = node.attrs.caption || '';
    const mediaName: string = node.attrs.mediaName ?? '';
    const src = resolveMediaUrl(mediaName) || node.attrs.src || '';
    const showPlaceholder = !src;
    const alt = node.attrs.alt || '';
    const isEditable = editor.isEditable;
    const layout = (node.attrs.layout || 'block') as FigureLayout;

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

    const getMaxWidth = useCallback(() => figureMaxWidth(containerRef.current, layout), [layout]);

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
            setAttributes({ width: Math.round(w) });
        },
        [setAttributes],
    );

    const displayWidth = previewWidth ?? width;
    // A picture no browser draws (WMF, EMF) shows its alt text, which a small width squeezes, so its box takes 10rem,
    // or all its container gives: a fixed minimum would push a narrow table cell wider. The wrapper takes it too, as a
    // wrapped figure floats and shrinks to fit. With no alt text the image would draw 0 px tall, so it keeps a line.
    const failed = failedSrc === src;
    // Mount the shared transform chrome only once we have a resolvable px box (loaded, sized,
    // editable, not a pending placeholder). Otherwise a selected figure shows the plain ring.
    const box: Box | null =
        selected && isEditable && !showPlaceholder && aspectRatio && displayWidth
            ? { x: 0, y: 0, width: displayWidth, height: displayWidth / aspectRatio, angle: 0 }
            : null;

    return (
        <NodeViewWrapper
            as="span"
            ref={containerRef}
            className={cn('figure', failed && 'min-w-[min(10rem,100%)]')}
            data-layout={layout}
            data-alignment={alignment}
            data-drag-handle=""
            draggable={isEditable}
            style={{ cursor: isEditable ? 'grab' : undefined }}
            // ProseMirror never sees a node view's right-click (stopEvent), so the figure asks here.
            onContextMenu={(e: React.MouseEvent) => {
                const pos = getPos();
                if (pos !== undefined) onContextMenu(node, pos, e);
            }}
        >
            {/* Relative wrapper shrink-wraps the img so the inset-0 ObjectTransform ring
                lands exactly on the image box. When no transform mounts (placeholder,
                read-only, pre-load), the same ring shows via the class. It takes no focus: the
                editor's keymap resizes the selected figure, and a press stays free to start a drag. */}
            <div
                className={cn(
                    'relative',
                    failed && 'min-w-[min(10rem,100%)]',
                    selected && !box && 'eigen-selection-ring',
                )}
                role={selected && isEditable ? 'group' : undefined}
                aria-label={selected && isEditable ? 'Resize image' : undefined}
                aria-keyshortcuts={selected && isEditable ? FIGURE_RESIZE_KEYS : undefined}
            >
                {showPlaceholder ? (
                    <div style={{ width: `${displayWidth || FIGURE_DEFAULT_WIDTH}px`, aspectRatio: '16 / 10' }}>
                        <ImagePlaceholder />
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
                        // clamp in handleTransform/handleCommit and the Shift+Arrow keymap.
                        onTransform={handleTransform}
                        onCommit={handleCommit}
                    />
                )}
                {/* After the transform, so its NE grip never covers the mark. A button, so
                    ProseMirror leaves its press alone (no node select); a prevented press keeps
                    focus in the editor and starts no drag of the figure. */}
                {commentCardId && (
                    <button
                        type="button"
                        className="absolute top-0 right-0"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => onOpenComment(commentCardId)}
                        aria-label="Open comment"
                        title="Open comment"
                    >
                        <CommentIndicator color={commentColor} className="block" />
                    </button>
                )}
            </div>
            {caption && <span className="figcaption">{caption}</span>}
        </NodeViewWrapper>
    );
}

export const Figure = FigureNode.extend<FigureOptions>({
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
            const width = Math.min(maxWidth, (selection.node.attrs.width || drawn) + delta);
            return this.editor.commands.updateFigure({ width: Math.round(Math.max(FIGURE_MIN_WIDTH, width)) });
        };
        return Object.fromEntries(
            Object.entries(FIGURE_RESIZE_STEPS).map(([key, step]) => [`Shift-${key}`, resize(step)]),
        );
    },
    addProseMirrorPlugins() {
        const name = this.name;
        return [
            new Plugin({
                key: new PluginKey('figureClickBeside'),
                props: {
                    // A block figure's box is the column's width, so a click in the empty space beside the image lands
                    // on the box: it puts the caret on that side, where ProseMirror would select the node.
                    handleClickOn(view, _pos, node, nodePos, event, direct) {
                        const box = view.nodeDOM(nodePos)?.firstChild;
                        if (!direct || node.type.name !== name || event.target !== box || !(box instanceof Element))
                            return false;
                        const image = box.firstElementChild?.getBoundingClientRect();
                        if (!image) return false;
                        const at = event.clientX < image.left + image.width / 2 ? nodePos : nodePos + node.nodeSize;
                        view.focus();
                        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
                        return true;
                    },
                },
            }),
            new Plugin({
                key: new PluginKey('figureDragOut'),
                // A figure dragged out of a paragraph of its own takes the paragraph with it, where the
                // paragraph's parent can do without it. ProseMirror's drop moves the selected node.
                appendTransaction(transactions, oldState, newState) {
                    const dragged = oldState.selection;
                    if (
                        !transactions.some((tr) => tr.getMeta('uiEvent') === 'drop') ||
                        !(dragged instanceof NodeSelection) ||
                        dragged.node.type.name !== name
                    )
                        return null;
                    const mapping = new Mapping();
                    for (const tr of transactions) mapping.appendMapping(tr.mapping);
                    const $start = newState.doc.resolve(mapping.map(dragged.$from.before(), 1));
                    const paragraph = $start.nodeAfter;
                    if (
                        !paragraph?.isTextblock ||
                        paragraph.content.size > 0 ||
                        !$start.parent.canReplace($start.index(), $start.index() + 1)
                    )
                        return null;
                    return newState.tr.delete($start.pos, $start.pos + paragraph.nodeSize);
                },
            }),
        ];
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
