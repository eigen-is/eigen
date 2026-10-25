import type { JSONContent } from '@tiptap/core';
import type { TitleType } from '@workspace/lib/docs/eigendoc';
import { isFigureFrameNode, readParagraphFormat } from '@workspace/lib/docs/eigendoc';
import type { Border } from '../../../document/looks';
import {
    BLOCK_MARGINS,
    CODE_BLOCK_LOOK,
    cssPt,
    nodeLook,
    proseTextLook,
    QUOTE_LOOK,
    TITLE_SELECTORS,
    textMetrics,
    twips,
    untypedListFormat,
} from '../../../document/looks';
import { lowlight } from '../../../document/lowlight';
import { proseValueIfSet } from '../../../document/prose-css';
import type { StyleId } from '../../../ooxml/wordml';
import { BORDER_SIDES, codeBlockStyle, JUSTIFICATION, LIST_FORMATS, LIST_LEVELS } from '../../../ooxml/wordml';
import type { HastNode } from '../render';
import { highlightCode } from '../render';
import { figureOf } from './drawings';
import type { RunFace } from './fonts';
import { familyLine, useFace } from './fonts';
import { CLEAR_FLOATS, checkboxXml, itemOf, LIST_LEVEL, listOf } from './numbering';
import type { Context, Package } from './package';
import type { RunProps } from './runs';
import { INLINES, LINE_BREAK, rPrXml, runsXml, textXml } from './runs';
import type { Styles } from './styles';
import { HAIRLINE_TWIPS, normalLine, proseTwips } from './styles';
import { TABLE_LOOK, tableOf } from './tables';

// Each block as paragraphs and tables, a paragraph's properties written in the ECMA-376 sequence: Word reports a
// child out of order as unreadable content.

type Spacing = { before?: number; after?: number; line?: number; exact?: true };

export type NumberingRef = { numId: number; ilvl: number };

export type ParagraphProps = {
    style?: StyleId;
    // A code block's language, written as its own style on top of style; every look still reads style.
    language?: string;
    keepNext?: true;
    keepLines?: true;
    numPr?: NumberingRef;
    pBdr?: Partial<Record<(typeof BORDER_SIDES)[number], Border>>;
    shading?: string;
    spacing?: Spacing;
    ind?: { left: number; right?: number; firstLine?: number; hanging?: number };
    contextualSpacing?: true;
    jc?: string;
    outlineLvl?: number;
};

// A figure's paragraphs carry its margin as an inset, inside their own spacing, which never collapses.
export type Paragraph = { props: ParagraphProps; runs: string; inset?: Inset };

export type Inset = { top: number; bottom: number };

// The block after an in-flow table takes its after; a floating one holds a wrapped figure and keeps no margin.
export type Block = Paragraph | { table: string; after?: number; float?: true };

export function pPrXml(props: ParagraphProps): string {
    const {
        style,
        language,
        keepNext,
        keepLines,
        numPr,
        pBdr,
        shading,
        spacing,
        ind,
        contextualSpacing,
        jc,
        outlineLvl,
    } = props;
    return [
        style && `<w:pStyle w:val="${language === undefined ? style : codeBlockStyle(language).id}"/>`,
        keepNext && '<w:keepNext/>',
        keepLines && '<w:keepLines/>',
        numPr && `<w:numPr><w:ilvl w:val="${numPr.ilvl}"/><w:numId w:val="${numPr.numId}"/></w:numPr>`,
        pBdr && `<w:pBdr>${bordersXml(BORDER_SIDES, pBdr)}</w:pBdr>`,
        shading && `<w:shd w:val="clear" w:color="auto" w:fill="${shading}"/>`,
        spacing &&
            `<w:spacing${spacing.before === undefined ? '' : ` w:before="${spacing.before}"`}${spacing.after === undefined ? '' : ` w:after="${spacing.after}"`}${spacing.line === undefined ? '' : ` w:line="${spacing.line}" w:lineRule="${spacing.exact ? 'exact' : 'auto'}"`}/>`,
        ind &&
            `<w:ind w:left="${ind.left}"${ind.right === undefined ? '' : ` w:right="${ind.right}"`}${ind.firstLine === undefined ? '' : ` w:firstLine="${ind.firstLine}"`}${ind.hanging === undefined ? '' : ` w:hanging="${ind.hanging}"`}/>`,
        contextualSpacing && '<w:contextualSpacing/>',
        jc && `<w:jc w:val="${jc}"/>`,
        outlineLvl !== undefined && `<w:outlineLvl w:val="${outlineLvl}"/>`,
    ]
        .filter(Boolean)
        .join('');
}

export function bordersXml<Side extends string>(
    sides: readonly Side[],
    borders: Partial<Record<Side, Border>>,
): string {
    return sides
        .map((side) => {
            const border = borders[side];
            return border
                ? `<w:${side} w:val="single" w:sz="${border.sz}" w:space="${border.space}" w:color="${border.color}"/>`
                : '';
        })
        .join('');
}

// An empty paragraph keeps its properties; only one with none is <w:p/>.
export function paragraphXml({ props, runs }: Paragraph): string {
    const pPr = pPrXml(props);
    if (!pPr && !runs) return '<w:p/>';
    return `<w:p>${pPr && `<w:pPr>${pPr}</w:pPr>`}${runs}</w:p>`;
}

// Word's built-in Title and Subtitle, in its gallery's order.
export const TITLE_STYLES = [
    { type: 'title', id: 'Title', uiPriority: 10 },
    { type: 'subtitle', id: 'Subtitle', uiPriority: 11 },
] as const;

const BLOCKS = new Map<string, (node: JSONContent, context: Context) => Block[]>([
    [
        'paragraph',
        (node, context) =>
            blocksOf(
                node.content ?? [],
                formatted(node, textProps({ jc: justification(node) }, context), context),
                context,
                true,
            ),
    ],
    [
        'heading',
        (node, context) => {
            const level = clampInt(node.attrs?.['level'], 1, 6, 1);
            const { sizePt } = textMetrics(`.eigen-prose h${level}`, context.pkg.normal.size);
            const firstMargin = context.first
                ? proseValueIfSet(`.eigen-prose h${level}:first-child`, 'margin-top')
                : undefined;
            const props = textProps(
                {
                    style: `Heading${level}`,
                    spacing: firstMargin === undefined ? undefined : { before: twips(cssPt(firstMargin, sizePt)) },
                    jc: justification(node),
                },
                context,
            );
            const upright = !!nodeLook('heading', level).italic;
            return blocksOf(
                node.content ?? [],
                formatted(node, props, context),
                { ...context, blockPt: sizePt, upright },
                true,
            );
        },
    ],
    ...TITLE_STYLES.map(({ type, id }) => [type, titleOf(type, id)] as const),
    ['pageBreak', () => [{ props: { style: 'PageBreak' }, runs: '<w:r><w:br w:type="page"/></w:r>' }]],
    [
        'horizontalRule',
        (_node, context) => [
            { props: { style: 'HorizontalRule', ind: indentOf('HorizontalRule', context) }, runs: '' },
        ],
    ],
    [
        'blockquote',
        (node, context) => {
            const indent = context.indent + (context.quotes < LIST_LEVELS ? QUOTE_LOOK.indent : 0);
            const quote: Context = { ...context, indent, quotes: context.quotes + 1, style: 'Quote', after: undefined };
            const blocks = blocksOf(node.content ?? [], textProps({}, quote), quote, false);
            return withAfter(blocks, BLOCK_MARGINS.blockquote, context.pkg.styles);
        },
    ],
    [
        'codeBlock',
        (node, context) => {
            const attr = node.attrs?.['language'];
            // Only a name lowlight knows is written: the style id and name carry it verbatim.
            const language = typeof attr === 'string' && lowlight.registered(attr) ? attr : undefined;
            if (language !== undefined) context.pkg.languages.add(language);
            const tree = highlightCode(language ?? '', textOf(node));
            // The mark of an empty or comment-only line draws in the style's Regular.
            useFace(context.pkg, {}, 'CodeBlock');
            const { indent } = CODE_BLOCK_LOOK;
            const ind = context.indent === 0 ? undefined : { left: context.indent + indent, right: indent };
            return codeLines(tree, context.pkg).map((runs) => ({ props: { style: 'CodeBlock', language, ind }, runs }));
        },
    ],
    ['bulletList', (node, context) => listOf(node, context, 'ul', { format: 'bullet', start: 1 })],
    [
        'orderedList',
        (node, context) => {
            const type = node.attrs?.['type'];
            const format = (typeof type === 'string' && LIST_FORMATS.get(type)) || untypedListFormat(context.numbered);
            return listOf(node, context, 'ol', { format, start: clampInt(node.attrs?.['start'], 0, 32767, 1) });
        },
    ],
    ['taskList', (node, context) => listOf(node, context, 'ul', undefined)],
    ['table', (node, context) => tableOf(node.content ?? [], context)],
    ['tableRow', (node, context) => tableOf([node], context)],
    ['tableCell', (node, context) => tableOf([{ type: 'tableRow', content: [node] }], context)],
    ['tableHeader', (node, context) => tableOf([{ type: 'tableRow', content: [node] }], context)],
    [
        'listItem',
        (node, context) =>
            itemOf(node, context, proseTwips('.eigen-prose li', 'margin-bottom'), (first) =>
                context.list ? { ...first, props: { ...first.props, numPr: context.list, ind: undefined } } : first,
            ),
    ],
    [
        'taskItem',
        (node, context) => {
            const checked = node.attrs?.['checked'] === true;
            const undone = context.style === 'TaskDone' ? context.undone : context.style;
            const item: Context = checked ? { ...context, style: 'TaskDone', undone } : { ...context, style: undone };
            context.pkg.checkboxes = true;
            const after = proseTwips('.eigen-prose ul[data-type="taskList"] li', 'margin-bottom');
            return itemOf(node, item, after, (first, inner) => ({
                ...first,
                props: { ...first.props, ind: { left: inner.indent, hanging: LIST_LEVEL } },
                runs: checkboxXml(checked) + first.runs,
            }));
        },
    ],
]);

function titleOf(type: TitleType, style: StyleId) {
    return (node: JSONContent, context: Context): Block[] => {
        const props = textProps({ style, jc: justification(node) }, context);
        const { sizePt } = textMetrics(TITLE_SELECTORS[type], context.pkg.normal.size);
        const upright = !!nodeLook(type).italic;
        return blocksOf(
            node.content ?? [],
            formatted(node, props, context),
            { ...context, blockPt: sizePt, upright },
            true,
        );
    };
}

// Never fails on structure: inline content where a block belongs is wrapped in a paragraph, a nested block hoisted out.
export function blocksOf(nodes: JSONContent[], props: ParagraphProps, context: Context, textblock: boolean): Block[] {
    const blocks: Block[] = [];
    let inline: JSONContent[] = [];
    // The in-flow pieces a figure or a display equation splits a textblock into, by index in blocks.
    const pieces: number[] = [];
    const flush = () => {
        const faces: RunFace[] = [];
        const runs = runsXml(inline, context, props.style, faces);
        const line = familyLine(
            props.spacing?.line ?? styleSpacing(context.pkg.styles, props.style, 'line'),
            useFace(context.pkg, {}, props.style),
            faces,
        );
        let own = line === undefined ? props : { ...props, spacing: { ...props.spacing, line } };
        // Word's navigator lists every paragraph at an outline level, so a heading a figure splits keeps one entry.
        if (pieces.length > 0 && props.style && context.pkg.styles.get(props.style)?.pPr?.outlineLvl !== undefined)
            own = { ...own, outlineLvl: 9 };
        pieces.push(blocks.push({ props: own, runs }) - 1);
        inline = [];
    };
    for (const [index, node] of nodes.entries()) {
        if (isFigureFrameNode(node.type)) {
            // A wrapped figure floats before the paragraph that holds it; a block one breaks the paragraph.
            const figure = figureOf(node, context);
            if (inline.length > 0 && figure.some((block) => !('float' in block))) flush();
            for (const block of figure) {
                const index = blocks.push(block) - 1;
                if (!('table' in block)) pieces.push(index);
            }
            continue;
        }
        // In Word a display equation is a paragraph of its own: it splits its textblock as a block figure does.
        if (node.type === 'equation' && node.attrs?.['display'] === true) {
            if (inline.length > 0) flush();
            inline.push(node);
            flush();
            continue;
        }
        if (INLINES.has(node.type ?? '')) {
            inline.push(node);
            continue;
        }
        if (inline.length > 0) flush();
        const write = BLOCKS.get(node.type ?? '');
        if (!write) throw new Error(`no docx mapping for ${node.type}`);
        const written = write(node, {
            ...context,
            first: !textblock && index === 0,
            next: nodes[index + 1]?.type,
            blockPt: undefined,
            upright: undefined,
        });
        if (BOXED.has(node.type ?? '') && BOXED.has(nodes[index - 1]?.type ?? ''))
            keepApart(blocks, written, context.pkg.styles);
        // A blank line before a page break draws nothing in Word, but readers whose page holds less push it onto a page
        // of its own, the break then adding another; the reader leaves it out too. The line a wrapped figure floats
        // from stays.
        if (node.type === 'pageBreak') {
            for (let last = blocks.at(-1); last && !('table' in last); last = blocks.at(-1)) {
                const previous = blocks.at(-2);
                const floatedFrom = previous && 'table' in previous && previous.float;
                if (last.runs !== '' || last.props.style !== undefined || last.props.numPr || last.props.pBdr) break;
                if (last.inset || floatedFrom) break;
                blocks.pop();
            }
        }
        // A loop, not a spread: a code block of a million lines is a million arguments.
        for (const block of written) blocks.push(block);
    }
    // A textblock its wrapped figures emptied keeps its line, as the editor's trailing break does.
    if (inline.length > 0 || (textblock && pieces.length === 0)) flush();
    if (textblock) shareMargins(blocks, pieces, props, context.pkg.styles);
    return blocks;
}

// The pieces share their textblock's margins: the first takes the one above, the last the one below, none at a split.
function shareMargins(blocks: Block[], pieces: number[], props: ParagraphProps, styles: Styles): void {
    const before = props.spacing?.before ?? styleSpacing(styles, props.style, 'before');
    const after = props.spacing?.after ?? styleSpacing(styles, props.style, 'after');
    for (const [order, index] of pieces.entries()) {
        const piece = blocks[index];
        if (!piece || 'table' in piece) continue;
        const first = order === 0;
        const last = order === pieces.length - 1;
        const own: Spacing = {};
        if (piece.inset) {
            if (first) own.before = before;
            if (last) own.after = after;
        } else {
            if (!first && before > 0) own.before = 0;
            if (!last && after > 0) own.after = 0;
        }
        if (own.before !== undefined || own.after !== undefined)
            blocks[index] = { ...piece, props: { ...piece.props, spacing: { ...piece.props.spacing, ...own } } };
    }
}

const BOXED = new Set(['codeBlock', 'blockquote']);

const SPACER: Paragraph = { props: { style: 'Spacer' }, runs: '' };

// Readers draw adjacent boxes or bars as one, so the gap between them becomes a Spacer, its margins collapsed as CSS does.
function keepApart(blocks: Block[], next: Block[], styles: Styles): void {
    const last = blocks.at(-1);
    const first = next[0];
    if ((last && 'table' in last && !last.float) || (first && 'table' in first && !first.float)) return;
    if (!last || !first || 'table' in last || 'table' in first) {
        blocks.push(SPACER);
        return;
    }
    const after = last.props.spacing?.after ?? styleSpacing(styles, last.props.style, 'after');
    const before = first.props.spacing?.before ?? styleSpacing(styles, first.props.style, 'before');
    if (after > 0)
        blocks[blocks.length - 1] = { ...last, props: { ...last.props, spacing: { ...last.props.spacing, after: 0 } } };
    if (before > 0) next[0] = { ...first, props: { ...first.props, spacing: { ...first.props.spacing, before: 0 } } };
    blocks.push({
        props: { style: 'Spacer', spacing: { before: Math.max(0, after - HAIRLINE_TWIPS, before - HAIRLINE_TWIPS) } },
        runs: '',
    });
}

// Word merges adjacent tables and needs a paragraph after a flow's last one, so a Spacer stands where none does.
export function blocksXml(written: Block[], styles: Styles): string {
    const below = (block: Block | undefined) =>
        block && 'table' in block && !block.float ? (block.after ?? TABLE_LOOK.margin) : undefined;
    const spacer = (before: number | undefined) =>
        paragraphXml(before === undefined ? SPACER : { props: { style: 'Spacer', spacing: { before } }, runs: '' });
    const blocks = withInsets(written, styles);
    return blocks
        .map((block, index) => {
            const previous = blocks[index - 1];
            const before = below(previous);
            if (!('table' in block))
                return paragraphXml(before === undefined ? block : withBefore(block, before, styles));
            const between = previous !== undefined && 'table' in previous ? spacer(before) : '';
            return `${between}${block.table}${index === blocks.length - 1 ? spacer(below(block)) : ''}`;
        })
        .join('');
}

// Readers collapse adjacent spacing to the larger, so an inset paragraph writes each whole gap on its side: the
// neighbour's inset, the two collapsed, its own inset. A float is out of the flow.
function withInsets(blocks: Block[], styles: Styles): Block[] {
    const flow = blocks.filter((block) => !('table' in block && block.float));
    const outer = (block: Block, side: 'before' | 'after') =>
        'table' in block
            ? side === 'after'
                ? (block.after ?? TABLE_LOOK.margin)
                : TABLE_LOOK.margin
            : (block.props.spacing?.[side] ?? styleSpacing(styles, block.props.style, side));
    const inset = (block: Block | undefined, side: keyof Inset) =>
        block && !('table' in block) ? (block.inset?.[side] ?? 0) : 0;
    const spaced = new Map<Block, Block>();
    for (const [index, block] of flow.entries()) {
        if ('table' in block || !block.inset) continue;
        const previous = flow[index - 1];
        const next = flow[index + 1];
        const before = previous
            ? inset(previous, 'bottom') + Math.max(outer(previous, 'after'), outer(block, 'before'))
            : outer(block, 'before');
        const after = next
            ? Math.max(outer(block, 'after'), outer(next, 'before')) + inset(next, 'top')
            : outer(block, 'after');
        const spacing = { ...block.props.spacing, before: before + block.inset.top, after: after + block.inset.bottom };
        spaced.set(block, { ...block, props: { ...block.props, spacing } });
    }
    return blocks.map((block) => spaced.get(block) ?? block);
}

// A plain paragraph takes its container's style and spacing, none of the Normal's before; a heading in a quote takes
// the quote's bar directly.
export function textProps(own: Pick<ParagraphProps, 'style' | 'spacing' | 'jc'>, context: Context): ParagraphProps {
    const style = own.style ?? context.style;
    return {
        style,
        pBdr: quoteBar(style, context),
        spacing:
            own.spacing ??
            (own.style || context.after === undefined
                ? undefined
                : { ...(context.pkg.normal.spaceBefore > 0 && { before: 0 }), after: context.after }),
        ind: indentOf(style, context),
        jc: own.jc ?? context.align,
    };
}

// A prose textblock's own format over what its style and container give it: its indent counts from the container's text.
// An item, a quote and a cell own the spacing of what they hold, as the editor draws it.
function formatted(node: JSONContent, props: ParagraphProps, context: Context): ParagraphProps {
    const format = readParagraphFormat(node.attrs ?? {});
    const spacing: Spacing = { ...props.spacing };
    if (format.lineSpacing !== undefined) spacing.line = normalLine(format.lineSpacing, context.pkg.normal);
    if (context.quotes === 0 && context.after === undefined) {
        if (format.spaceBefore !== undefined) spacing.before = twips(format.spaceBefore);
        if (format.spaceAfter !== undefined) spacing.after = twips(format.spaceAfter);
    }
    const { indentLeft, indentRight, indentFirstLine } = format;
    const indented = indentLeft !== undefined || indentRight !== undefined || indentFirstLine !== undefined;
    return {
        ...props,
        spacing: Object.keys(spacing).length > 0 ? spacing : undefined,
        ind: indented
            ? {
                  left: context.indent + twips(indentLeft ?? 0),
                  right: indentRight === undefined ? undefined : twips(indentRight),
                  firstLine: indentFirstLine !== undefined && indentFirstLine > 0 ? twips(indentFirstLine) : undefined,
                  hanging: indentFirstLine !== undefined && indentFirstLine < 0 ? twips(-indentFirstLine) : undefined,
              }
            : props.ind,
    };
}

// In a quote, a paragraph of another style draws the quote's bar itself, so the bar runs on past it.
export function quoteBar(style: StyleId | undefined, context: Context): ParagraphProps['pBdr'] {
    return context.quotes > 0 && style !== 'Quote' ? { left: QUOTE_LOOK.border } : undefined;
}

// Direct only where the style's own indent isn't the container's.
export function indentOf(style: StyleId | undefined, context: Context): ParagraphProps['ind'] {
    const own = (style && context.pkg.styles.get(style)?.pPr?.ind?.left) ?? 0;
    return context.indent === own ? undefined : { left: context.indent };
}

// A container's bottom margin on its last block, collapsed with its own; a hairline and a floating figure keep theirs.
export function withAfter(blocks: Block[], after: number, styles: Styles): Block[] {
    const last = blocks.at(-1);
    if (!last || ('table' in last && last.float)) return blocks;
    if ('table' in last) {
        if (after <= (last.after ?? TABLE_LOOK.margin)) return blocks;
        return [...blocks.slice(0, -1), { ...last, after }];
    }
    if (last.props.style === 'PageBreak' || (last.props.style === 'Spacer' && last.runs !== CLEAR_FLOATS))
        return blocks;
    if (after <= (last.props.spacing?.after ?? styleSpacing(styles, last.props.style, 'after'))) return blocks;
    return [...blocks.slice(0, -1), { ...last, props: { ...last.props, spacing: { ...last.props.spacing, after } } }];
}

// A band's last block has no space after, as the editor and the PDF draw it (PAGE_BAND_CLASS) and as Word's Header and
// Footer styles have none.
export function withoutAfter(blocks: Block[]): Block[] {
    const last = blocks.at(-1);
    if (!last || ('table' in last && last.float)) return blocks;
    if ('table' in last) return [...blocks.slice(0, -1), { ...last, after: 0 }];
    return [
        ...blocks.slice(0, -1),
        { ...last, props: { ...last.props, spacing: { ...last.props.spacing, after: 0 } } },
    ];
}

// Below an in-flow table. The editor draws a paragraph's space before, its own or the Normal's, as padding, which adds
// to the table's margin; a style's margin above, a heading's, collapses with it to the larger, and an inset paragraph's
// already holds the whole gap (withInsets).
function withBefore(paragraph: Paragraph, margin: number, styles: Styles): Paragraph {
    const { props } = paragraph;
    const own = props.spacing?.before;
    const space = own ?? styleSpacing(styles, props.style, 'before');
    const padded = !paragraph.inset && (own !== undefined || props.style === undefined || props.style === 'Normal');
    const before = padded ? margin + space : Math.max(margin, space);
    if (before === space) return paragraph;
    return { ...paragraph, props: { ...props, spacing: { ...props.spacing, before } } };
}

// What the style chain gives a paragraph: its own style, what that is based on, Normal for none.
export function styleSpacing(styles: Styles, style: StyleId | undefined, side: 'before' | 'after' | 'line'): number {
    for (let id = style ?? 'Normal'; ; ) {
        const definition = styles.get(id);
        const value = definition?.pPr?.spacing?.[side];
        if (value !== undefined) return value;
        if (!definition?.basedOn) return 0;
        id = definition.basedOn;
    }
}

function textOf(node: JSONContent): string {
    return node.text ?? (node.content ?? []).map(textOf).join('');
}

// ── Code blocks: one paragraph per line, lowlight's tokens as runs ─────────────────────────────────────────────────

// A token that spans lines is split at each break and keeps its color and italic on every line.
function codeLines(tree: HastNode, pkg: Package): string[] {
    const lines = [''];
    const walk = (node: HastNode, props: RunProps) => {
        if (node.type === 'text') {
            for (const [index, segment] of (node.value ?? '').split(LINE_BREAK).entries()) {
                if (index > 0) lines.push('');
                const content = textXml(segment);
                if (!content) continue;
                useFace(pkg, props, 'CodeBlock');
                const rPr = rPrXml(props);
                lines[lines.length - 1] += `<w:r>${rPr && `<w:rPr>${rPr}</w:rPr>`}${content}</w:r>`;
            }
            return;
        }
        const token = { ...props };
        for (const name of node.properties?.className ?? [])
            Object.assign(token, proseTextLook(`.eigen-prose pre .${name}`));
        for (const child of node.children ?? []) walk(child, token);
    };
    walk(tree, {});
    return lines;
}

function justification(node: JSONContent): string | undefined {
    const textAlign = node.attrs?.['textAlign'];
    return typeof textAlign === 'string' ? JUSTIFICATION.get(textAlign) : undefined;
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, Math.round(value)))
        : fallback;
}
