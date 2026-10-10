import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { FigureLayout } from '@workspace/lib/docs/eigendoc';
import { FigureNode } from '@workspace/lib/docs/eigendoc';
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

type FigureOptions = {
    // The host decides whether a menu opens, so an image with no rows keeps the browser's own.
    onContextMenu: (node: PMNode, pos: number, event: React.MouseEvent) => void;
    onOpenComment: (cardId: string) => void;
};

function FigureView({ node, updateAttributes, selected, editor, extension, getPos, decorations }: NodeViewProps) {
    const { onContextMenu, onOpenComment }: FigureOptions = extension.options;
    const commentCardId: string | null = node.attrs.commentCardId;
    const commentColor: string | undefined = decorations.find((d) => 'commentColor' in d.spec)?.spec.commentColor;
    const imageRef = useRef<HTMLImageElement>(null);
    const containerRef = useRef<HTMLSpanElement>(null);
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
    const showPlaceholder = !src;
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

    return (
        <NodeViewWrapper
            as="span"
            ref={containerRef}
            className="figure"
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
                read-only, pre-load), the same ring shows via the class. */}
            <div
                className={cn('relative', selected && !box && 'eigen-selection-ring')}
                tabIndex={selected && isEditable ? 0 : undefined}
                aria-label={selected && isEditable ? 'Resize image' : undefined}
                onKeyDown={selected && isEditable ? handleKeyResize : undefined}
                // A press focuses this wrapper, which would take the keys from ProseMirror, so focus goes
                // back to the editor; only Tab focus stays, for keyboard resize. The press itself is left
                // alone: a prevented mousedown starts no native drag.
                onFocus={(e) => {
                    if (e.target === e.currentTarget && !e.currentTarget.matches(':focus-visible')) editor.view.focus();
                }}
            >
                {showPlaceholder ? (
                    <div style={{ width: displayWidth ? `${displayWidth}px` : '400px', aspectRatio: '16 / 10' }}>
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
                {/* After the transform, so its NE grip never covers the mark. A button, so
                    ProseMirror leaves its press alone (no node select, no drag). */}
                {commentCardId && (
                    <button
                        type="button"
                        className="absolute top-0 right-0"
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
                        dragged.node.type.name !== name ||
                        dragged.$from.parent.childCount !== 1
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
