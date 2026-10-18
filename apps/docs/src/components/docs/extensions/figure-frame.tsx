import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper } from '@tiptap/react';
import type { FigureLayout } from '@workspace/lib/docs/eigendoc';
import { cmText, pxToMm } from '@workspace/lib/docs/eigendoc';
import type { Box } from '@workspace/lib/vector';
import { CommentIndicator } from '@workspace/ui/components/comments';
import { ObjectTransform } from '@workspace/ui/components/transform/object-transform';
import { cn } from '@workspace/ui/lib/utils';
import type React from 'react';
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { textColumnWidth } from './text-column';

// The resize floor of a figure's side (px).
export const FIGURE_MIN_SIZE = 100;

// The text column, or half of it for a wrapped figure: the widest a resize makes it.
export function figureMaxWidth(figure: Node | null, layout: FigureLayout | null) {
    const fullWidth = textColumnWidth(figure) ?? Infinity;
    return layout === 'wrap-left' || layout === 'wrap-right' ? fullWidth * 0.5 : fullWidth;
}

// The width a grip, Shift and an arrow, or the panel's Width field writes.
export function clampFigureWidth(width: number, maxWidth: number) {
    return Math.round(Math.max(FIGURE_MIN_SIZE, Math.min(maxWidth, width)));
}

// A wrap halves the cap, so a switch to one shrinks a wider figure to it in the same write, or nothing wraps beside it.
// The width to write with `layout`, none when the figure fits.
export function widthWithinLayout(
    figure: Node | null,
    layout: FigureLayout | null | undefined,
    width: number | null | undefined,
): number | undefined {
    if (!layout || !width) return undefined;
    const maxWidth = figureMaxWidth(figure, layout);
    return width > maxWidth ? clampFigureWidth(width, maxWidth) : undefined;
}

// A grip's readout, in cm as Docs' fields show a size.
const figureSize = ({ width, height }: Box) => `${cmText(pxToMm(width), 1)} × ${cmText(pxToMm(height), 1)} cm`;

export type FigureFrameOptions = {
    // The host decides whether a menu opens, so a figure with no rows keeps the browser's own.
    onContextMenu: (node: PMNode, pos: number, event: React.MouseEvent) => void;
    onOpenComment: (cardId: string) => void;
};

// A resize previews locally and writes once, at the commit. `fit` turns a dragged box into the size the node keeps.
export function useFigureResize<T>({
    active,
    getMaxWidth,
    fit,
    commit,
}: {
    active: boolean;
    getMaxWidth: () => number;
    fit: (box: Box, maxWidth: number) => T;
    commit: (size: T) => void;
}): { preview: T | null; onTransform: (next: Box) => void; onCommit: (next: Box) => void } {
    const [preview, setPreview] = useState<T | null>(null);
    // ObjectTransform has no onStart, so the first onTransform of a gesture latches the max width: a forced layout
    // per move costs too much.
    const transformStarted = useRef(false);
    const gestureMaxWidth = useRef(Number.POSITIVE_INFINITY);

    // ObjectTransform's Escape-cancel and no-move-click paths fire no onCommit, so a leftover preview would stick.
    // Any pointerup drops it and re-arms the latch. Only the selected, editable figure holds these listeners, and the
    // teardown clears too, so a deselect mid-gesture can't strand a stale preview.
    useEffect(() => {
        if (!active) return;
        const clear = () => {
            transformStarted.current = false;
            setPreview((p) => (p === null ? p : null));
        };
        document.addEventListener('pointerup', clear);
        document.addEventListener('pointercancel', clear);
        return () => {
            document.removeEventListener('pointerup', clear);
            document.removeEventListener('pointercancel', clear);
            clear();
        };
    }, [active]);

    const onTransform = useCallback(
        (next: Box) => {
            if (!transformStarted.current) {
                transformStarted.current = true;
                // A hidden surface reports <=0, which the fit's floor wins over.
                gestureMaxWidth.current = getMaxWidth();
            }
            setPreview(fit(next, gestureMaxWidth.current));
        },
        [getMaxWidth, fit],
    );

    const onCommit = useCallback(
        (next: Box) => {
            transformStarted.current = false;
            setPreview(null);
            commit(fit(next, gestureMaxWidth.current));
        },
        [fit, commit],
    );

    return { preview, onTransform, onCommit };
}

type FigureFrameProps = Pick<NodeViewProps, 'node' | 'selected' | 'editor' | 'extension' | 'getPos' | 'decorations'> & {
    containerRef: RefObject<HTMLSpanElement | null>;
    // The box the transform chrome resizes; none shows the plain ring on a selected figure.
    box: Box | null;
    resizeMode: 'aspect' | 'free';
    onTransform: (next: Box) => void;
    onCommit: (next: Box) => void;
    label: string;
    keyShortcuts?: string;
    className?: string;
    children: ReactNode;
};

// The figure box the node view draws: the wrapper the page's .figure rules lay out, the selection ring and the
// transform chrome over the content, the comment mark and the caption.
export function FigureFrame({
    node,
    selected,
    editor,
    extension,
    getPos,
    decorations,
    containerRef,
    box,
    resizeMode,
    onTransform,
    onCommit,
    label,
    keyShortcuts,
    className,
    children,
}: FigureFrameProps) {
    const { onContextMenu, onOpenComment }: FigureFrameOptions = extension.options;
    const commentCardId: string | null = node.attrs.commentCardId;
    const commentColor: string | undefined = decorations.find((d) => 'commentColor' in d.spec)?.spec.commentColor;
    const caption = node.attrs.caption || '';
    const isEditable = editor.isEditable;
    // The ring insets over the content, shrink-wrapped by the relative wrapper. A figure's size is in the page's pixels,
    // and the page draws scaled below its width, so a pointer delta divides by the scale, measured as a grip is pressed.
    const boxToStyle = useCallback((): React.CSSProperties => ({ inset: 0 }), []);
    const pageScale = useRef(1);
    const screenDeltaToScene = useCallback(
        (dx: number, dy: number) => ({ dx: dx / pageScale.current, dy: dy / pageScale.current }),
        [],
    );
    const measurePageScale = () => {
        const figure = containerRef.current;
        if (figure && figure.offsetWidth > 0)
            pageScale.current = figure.getBoundingClientRect().width / figure.offsetWidth;
    };

    return (
        <NodeViewWrapper
            as="span"
            ref={containerRef}
            className={cn('figure', className)}
            data-layout={node.attrs.layout || 'block'}
            data-alignment={node.attrs.alignment || 'center'}
            data-drag-handle=""
            draggable={isEditable}
            style={{ cursor: isEditable ? 'grab' : undefined }}
            // ProseMirror never sees a node view's right-click (stopEvent), so the figure asks here.
            onContextMenu={(e: React.MouseEvent) => {
                const pos = getPos();
                if (pos !== undefined) onContextMenu(node, pos, e);
            }}
        >
            {/* Relative wrapper shrink-wraps the content so the inset-0 ObjectTransform ring lands exactly on it. When
                no transform mounts (placeholder, read-only, pre-load), the same ring shows via the class. It takes no
                focus: the editor's keymap resizes the selected figure, and a press stays free to start a drag. */}
            <div
                className={cn('relative', className, selected && !box && 'eigen-selection-ring')}
                onPointerDownCapture={measurePageScale}
                role={selected && isEditable ? 'group' : undefined}
                aria-label={selected && isEditable ? label : undefined}
                aria-keyshortcuts={selected && isEditable ? keyShortcuts : undefined}
            >
                {children}
                {box && (
                    <ObjectTransform
                        box={box}
                        boxToStyle={boxToStyle}
                        screenDeltaToScene={screenDeltaToScene}
                        showRotate={false}
                        resizeMode={resizeMode}
                        formatSize={figureSize}
                        // Default minSize (1): in aspect mode the component floors BOTH dims, which would inflate
                        // wide images (a 100 floor on a 4:1 banner's height forces width 400). The host's fit clamps.
                        onTransform={onTransform}
                        onCommit={onCommit}
                    />
                )}
                {/* After the transform, so its NE grip never covers the mark. A button, so ProseMirror leaves its
                    press alone (no node select); a prevented press keeps focus in the editor and starts no drag. */}
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

// A click beside a block figure's content and a drag out of its paragraph, for the figure node named `name`.
export function figureFramePlugins(name: string): Plugin[] {
    return [
        new Plugin({
            key: new PluginKey('figureClickBeside'),
            props: {
                // A block figure's box is the column's width, so a click in the empty space beside the content lands
                // on the box: it puts the caret on that side, where ProseMirror would select the node.
                handleClickOn(view, _pos, node, nodePos, event, direct) {
                    const box = view.nodeDOM(nodePos)?.firstChild;
                    if (!direct || node.type.name !== name || event.target !== box || !(box instanceof Element))
                        return false;
                    const content = box.firstElementChild?.getBoundingClientRect();
                    if (!content) return false;
                    const at = event.clientX < content.left + content.width / 2 ? nodePos : nodePos + node.nodeSize;
                    view.focus();
                    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
                    return true;
                },
            },
        }),
        new Plugin({
            key: new PluginKey('figureDragOut'),
            // A figure dragged out of a paragraph of its own takes the paragraph with it, where the paragraph's
            // parent can do without it. ProseMirror's drop moves the selected node.
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
}
