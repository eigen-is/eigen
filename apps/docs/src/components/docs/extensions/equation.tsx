import { NodeSelection } from '@tiptap/pm/state';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { EquationNode, equationMath, readEquation } from '@workspace/lib/docs/eigendoc';
import { CommentIndicator } from '@workspace/ui/components/comments';
import { cn } from '@workspace/ui/lib/utils';
import { useLayoutEffect, useMemo, useRef } from 'react';

// Mounts a <math> built by the DOM: React would create MathML children in the HTML namespace.
export function MathMount({ math, className }: { math: Element; className?: string }) {
    const ref = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => {
        ref.current?.replaceChildren(math);
    }, [math]);
    return <span ref={ref} className={className} />;
}

type EquationOptions = {
    onOpenComment: (cardId: string) => void;
    onEdit: () => void;
};

function EquationView({ node, selected, extension, decorations }: NodeViewProps) {
    const { onOpenComment }: EquationOptions = extension.options;
    const commentCardId: string | null = node.attrs.commentCardId;
    const commentColor: string | undefined = decorations.find((d) => 'commentColor' in d.spec)?.spec.commentColor;
    const { mathml, display } = node.attrs;
    // Read once per stored string: the view re-renders on every decoration change.
    const equation = useMemo(() => readEquation({ mathml, display }), [mathml, display]);
    const math = useMemo(() => equationMath(equation), [equation]);

    return (
        <NodeViewWrapper
            as="span"
            className={cn('equation', selected && 'eigen-selection-ring')}
            data-display={equation.display || undefined}
        >
            {equation.row.length === 0 ? (
                <span className="equation-placeholder" role="img" aria-label="Empty equation" />
            ) : (
                <MathMount math={math} className="contents" />
            )}
            {/* As the figure's corner mark: a button, so ProseMirror leaves its press alone, and a prevented press
                keeps focus in the editor. */}
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
        </NodeViewWrapper>
    );
}

export const Equation = EquationNode.extend<EquationOptions>({
    addOptions() {
        return { onOpenComment: () => {}, onEdit: () => {} };
    },
    addKeyboardShortcuts() {
        return {
            // As a click on it: an arrow selects an equation without opening its panel.
            Enter: ({ editor }) => {
                const { selection } = editor.state;
                if (!(selection instanceof NodeSelection) || selection.node.type.name !== this.name) return false;
                this.options.onEdit();
                return true;
            },
        };
    },
    addNodeView() {
        // TipTap skips the re-render when only decorations change, and the comment mark's color arrives as one.
        return ReactNodeViewRenderer(EquationView, {
            update: ({ updateProps }) => {
                updateProps();
                return true;
            },
        });
    },
});
