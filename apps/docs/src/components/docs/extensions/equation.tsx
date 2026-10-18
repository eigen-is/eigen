import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { CELL_INDICATOR_SIZE } from '@workspace/lib/constants/comment-indicator';
import {
    type Equation as EquationAttributes,
    EquationNode,
    equationMath,
    readEquation,
} from '@workspace/lib/docs/eigendoc';
import { type MathNode, type MathRow, writeMathml } from '@workspace/math';
import { CommentIndicator } from '@workspace/ui/components/comments';
import { cn } from '@workspace/ui/lib/utils';
import { useLayoutEffect, useMemo, useRef } from 'react';

const SLOT = '\u2B1A';

// Word's dotted box in each empty argument. Not a script's base, which `{}^{14}C` empties on purpose, nor a large
// operator's or a function's body, a fence or a table's cell.
function withSlots(row: MathRow): MathRow {
    const required = (slot: MathRow): MathRow => (slot.length === 0 ? [{ kind: 'text', text: SLOT }] : withSlots(slot));
    const optional = (slot: MathRow | undefined) => slot && withSlots(slot);
    return row.map((node): MathNode => {
        switch (node.kind) {
            case 'fraction':
                return { ...node, numerator: required(node.numerator), denominator: required(node.denominator) };
            case 'radical':
                return { ...node, body: required(node.body), degree: optional(node.degree) };
            case 'accent':
            case 'line':
            case 'brace':
            case 'enclose':
                return { ...node, body: required(node.body) };
            case 'limit':
                return { ...node, base: required(node.base), limit: required(node.limit) };
            case 'scripts':
                return { ...node, base: withSlots(node.base), sub: optional(node.sub), sup: optional(node.sup) };
            case 'nary':
                return { ...node, sub: optional(node.sub), sup: optional(node.sup), body: withSlots(node.body) };
            case 'function':
                return { ...node, name: withSlots(node.name), body: withSlots(node.body) };
            case 'fenced':
                return { ...node, parts: node.parts.map(withSlots) };
            case 'table':
                return { ...node, rows: node.rows.map((cells) => cells.map(withSlots)) };
            default:
                return node;
        }
    });
}

// The <math> the editor and its panel draw, with the slots an export never holds.
export function drawnMath({ row, display }: Pick<EquationAttributes, 'row' | 'display'>): Element {
    const math = equationMath({ mathml: writeMathml(withSlots(row)), display });
    for (const text of math.querySelectorAll('mtext')) {
        if (text.textContent === SLOT) text.classList.add('equation-slot');
    }
    return math;
}

// Mounts a <math> built by the DOM: React would create MathML children in the HTML namespace.
export function MathMount({ math, className }: { math: Element; className?: string }) {
    const ref = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => {
        ref.current?.replaceChildren(math);
    }, [math]);
    return <span ref={ref} className={className} />;
}

export type EquationOptions = {
    onOpenComment: (cardId: string) => void;
    // None in a band or on a phone, which have no Equation panel: Enter there splits the paragraph, as on a figure.
    onEdit: (() => void) | undefined;
};

function EquationView({ node, selected, extension, decorations }: NodeViewProps) {
    const { onOpenComment }: EquationOptions = extension.options;
    const commentCardId: string | null = node.attrs.commentCardId;
    const commentColor: string | undefined = decorations.find((d) => 'commentColor' in d.spec)?.spec.commentColor;
    const { mathml, display } = node.attrs;
    // Read once per stored string: the view re-renders on every decoration change.
    const equation = useMemo(() => readEquation({ mathml, display }), [mathml, display]);
    const math = useMemo(() => drawnMath(equation), [equation]);

    return (
        <NodeViewWrapper
            as="span"
            className={cn('equation', selected && 'eigen-selection-ring')}
            data-display={equation.display || undefined}
            // Room for the corner mark beside the glyphs, which it would cover.
            style={commentCardId ? { paddingRight: CELL_INDICATOR_SIZE } : undefined}
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
                    <CommentIndicator color={commentColor} className="pointer-events-none block" />
                </button>
            )}
        </NodeViewWrapper>
    );
}

export const Equation = EquationNode.extend<EquationOptions>({
    addOptions() {
        return { onOpenComment: () => {}, onEdit: undefined };
    },
    addKeyboardShortcuts() {
        return {
            // As a click on it: an arrow selects an equation without opening its panel.
            Enter: ({ editor }) => {
                const { selection } = editor.state;
                const { onEdit } = this.options;
                if (!onEdit || !(selection instanceof NodeSelection) || selection.node.type.name !== this.name) {
                    return false;
                }
                onEdit();
                return true;
            },
        };
    },
    addProseMirrorPlugins() {
        const { name, options } = this;
        return [
            new Plugin({
                key: new PluginKey('equationClickSelected'),
                props: {
                    // ProseMirror dispatches no selection a click doesn't change, so a click on the equation an arrow
                    // selected opens its panel here, as Enter does.
                    handleClickOn(view, _pos, node, nodePos, _event, direct) {
                        const { selection } = view.state;
                        const selected = selection instanceof NodeSelection && selection.from === nodePos;
                        if (!options.onEdit || !direct || node.type.name !== name || !selected) return false;
                        options.onEdit();
                        return true;
                    },
                },
            }),
        ];
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
