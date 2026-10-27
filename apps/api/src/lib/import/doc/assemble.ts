// Turns the paragraph reader's items into the doc's blocks: floats and captions join their paragraph, quotes nest by
// depth, lists by level, and code lines join into code blocks. The body, a band, a note and a table cell each go
// through it. The body's figures in front of or behind the text then take their place from their paragraph's box.

import type { JSONContent } from '@tiptap/core';
import type { NormalStyle } from '@workspace/lib/docs/eigendoc';
import {
    isFigureFrameNode,
    isPositioned,
    PROSE_TEXTBLOCKS,
    ptToTwips,
    readFigureFrameAttrs,
    readParagraphFormat,
    twipsToPt,
} from '@workspace/lib/docs/eigendoc';
import { readStoredEquation } from '../../document/equation';
import {
    anchorIndentPx,
    anchorPaddingPx,
    BLOCK_MARGINS,
    CODE_BLOCK_LOOK,
    FIGURE_MARGIN,
    LIST_LEVEL,
    QUOTE_LOOK,
    TABLE_MARGIN,
    untypedListFormat,
} from '../../document/looks';
import { LIST_FORMATS, LIST_LEVELS, LIST_TYPES } from '../../ooxml/wordml';
import type { ListRef } from './numbering';
import type { Role } from './styles';

export type ParagraphItem = {
    kind: 'para';
    role: Role;
    inlines: JSONContent[];
    textAlign: string | null;
    list?: ListRef & { ilvl: number };
    task?: { checked: boolean };
    // A half after a page break, which continues its item rather than numbering again.
    continued: boolean;
    indLeft: number;
    // Where an item's number or checkbox starts: at or right of the open item's text, it nests there.
    numberAt?: number;
    quote: number;
    // A quote inside a list item above it: that item, whose quote depth it sits at.
    inItem?: ParagraphItem;
    // The writer's code box, whose indent counts its quotes.
    boxed?: boolean;
    // A tracked deletion of the mark: accepted, the content joins the next paragraph.
    joinsNext?: boolean;
    // The first inline is a numbered heading's number.
    labelled?: boolean;
    empty: boolean;
    small: boolean;
    // Every text run in the writer's caption size and color, the Caption style as a Google Docs re-save flattens it.
    captionLook?: boolean;
    // The side of the text frame it stands in, which holds a wrapped figure and its caption.
    frame?: 'left' | 'right';
    hairline: boolean;
    // What it sets apart from the docx's Normal, in pt. baseBefore and baseAfter are the spaces its style or the Normal
    // gives it. The indent below is its own, in twips, counted from its container's text; an item's holds its number.
    format?: {
        lineSpacing?: number;
        spaceBefore?: number;
        spaceAfter?: number;
        baseBefore?: number;
        baseAfter?: number;
    };
    indent?: { left: number; right: number; firstLine: number };
};

export type Item =
    | ParagraphItem
    | { kind: 'break' }
    | { kind: 'boundary' }
    // A rule's or a table's quote: the writer indents either in a quote to the quote's text.
    | { kind: 'hr'; indent: number; quote?: number }
    | { kind: 'table'; node: JSONContent; indent: number; quote?: number }
    // A quote in a list item: where its first line starts, which says which open item holds it.
    | { kind: 'block'; node: JSONContent; itemAt?: number }
    | { kind: 'float'; figure: JSONContent };

// Deeper quotes join the deepest, so a hostile indent can't nest without end.
export const MAX_QUOTE_DEPTH = 8;

const INDENT_TOLERANCE = 60;

const ASCII_WHITESPACE = /^[ \t\r\n]*$/;

export function isWhitespace(node: JSONContent): boolean {
    return node.type === 'text' && ASCII_WHITESPACE.test(node.text ?? '');
}

export function buildBlocks(raw: Item[]): JSONContent[] {
    const items = attachFloatsAndCaptions(joinDeletedMarks(raw));
    assignQuotes(items);
    return buildLevel(items, 0);
}

// The body's figures in front of or behind the text, which the reader placed as Word does, from the text column and
// from the paragraph's first line, are placed from their paragraph's box as Eigen draws it: past the indents of the
// lists and quotes around it and its own, and below the padding above its text. Each leads its paragraph, as the
// editor keeps it. The writer converts the other way through the same looks.
export function placeAnchors(blocks: JSONContent[], normal: NormalStyle): JSONContent[] {
    const walk = (node: JSONContent, indent: number, depth: number, quotes: number) => {
        if (PROSE_TEXTBLOCKS.includes(node.type ?? '')) {
            const anchored = node.content?.filter((child) => isFigureFrameNode(child.type) && !isInFlowFigure(child));
            if (!anchored || anchored.length === 0) return;
            const contained = depth > 0 || quotes > 0;
            for (const { attrs } of anchored) {
                if (!attrs) continue;
                attrs['offsetX'] = Math.round(attrs['offsetX'] - anchorIndentPx(indent, node));
                const fromLine = attrs['offsetY'];
                const y = fromLine === null ? 0 : fromLine + anchorPaddingPx(node, contained, normal);
                attrs['offsetY'] = readFigureFrameAttrs({ offsetY: Math.round(y) }).offsetY;
            }
            node.content = [...anchored, ...(node.content ?? []).filter((child) => !anchored.includes(child))];
            return;
        }
        // As the writer indents them, no deeper than Word's levels.
        const item = node.type === 'listItem' || node.type === 'taskItem';
        const quote = node.type === 'blockquote';
        const inner =
            indent +
            (item && depth < LIST_LEVELS ? LIST_LEVEL : 0) +
            (quote && quotes < LIST_LEVELS ? QUOTE_LOOK.indent : 0);
        for (const child of node.content ?? []) walk(child, inner, depth + Number(item), quotes + Number(quote));
    };
    for (const block of blocks) walk(block, 0, 0, 0);
    return blocks;
}

// An equation is set off from the text and equations beside it by a space where none is.
export function inlineText(nodes: JSONContent[]): string {
    let text = '';
    let spaceNext = false;
    for (const node of nodes) {
        const equation = node.type === 'equation';
        const part =
            node.type === 'hardBreak' ? '\n' : equation ? readStoredEquation(node.attrs ?? {}).text : (node.text ?? '');
        if (part && text && !/\s$/.test(text) && !/^\s/.test(part) && (spaceNext || equation)) text += ' ';
        text += part;
        if (part) spaceNext = equation;
    }
    return text;
}

// Word's Caption style, or a short line of small text, as Google Docs flattens the style.
export function isCaptionLike(para: ParagraphItem): boolean {
    return !para.empty && (para.role.kind === 'caption' || (para.small && !para.list && !para.task));
}

// A figure in front of or behind the text is out of the flow, so it counts as whitespace: a heading that anchors one
// stays a heading, and it takes no caption.
export function isFigureOnly(para: ParagraphItem): boolean {
    return (
        para.inlines.some(isInFlowFigure) &&
        para.inlines.every((node) => isFigureFrameNode(node.type) || isWhitespace(node))
    );
}

function isInFlowFigure(node: JSONContent): boolean {
    return isFigureFrameNode(node.type) && !isPositioned(readFigureFrameAttrs(node.attrs ?? {}).layout);
}

// A blank line before a page ends there and would draw as a blank page in Eigen, whose empty lines are taller than Word's.
function isBlank(item: Item | undefined): boolean {
    return (
        item?.kind === 'para' &&
        !item.list &&
        !item.task &&
        !item.continued &&
        item.role.kind !== 'hr' &&
        item.inlines.every(isWhitespace)
    );
}

// The joined paragraph is the next one, with its own properties: its mark is the one that stays; a run joins at once.
function joinDeletedMarks(raw: Item[]): Item[] {
    let joined: ParagraphItem[] = [];
    return raw.filter((item, index) => {
        if (item.kind !== 'para') return true;
        if (item.joinsNext && raw[index + 1]?.kind === 'para') {
            joined.push(item);
            return false;
        }
        if (joined.length === 0) return true;
        const at = item.labelled ? 1 : 0;
        item.inlines = [
            ...item.inlines.slice(0, at),
            ...joined.flatMap((para) => para.inlines),
            ...item.inlines.slice(at),
        ];
        item.empty &&= joined.every((para) => para.empty);
        joined = [];
        return true;
    });
}

// The roles that become a textblock, which a float before it joins.
const HOLDS_FLOATS = new Set<Role['kind']>(['paragraph', 'heading', 'title', 'subtitle', 'taskDone']);

function attachFloatsAndCaptions(raw: Item[]): Item[] {
    const items: Item[] = [];
    let floats: JSONContent[] = [];
    for (const item of raw) {
        if (item.kind === 'float') {
            floats.push(item.figure);
            continue;
        }
        if (item.kind === 'break') while (isBlank(items.at(-1))) items.pop();
        if (item.kind === 'para') {
            if (floats.length > 0 && HOLDS_FLOATS.has(item.role.kind)) {
                // After a numbered heading's number, as joined text goes.
                const at = item.labelled ? 1 : 0;
                item.inlines = [...item.inlines.slice(0, at), ...floats, ...item.inlines.slice(at)];
                item.empty = false;
                floats = [];
            }
            // A block figure takes the next line in the Caption style or its look; a wrapped one only a caption in
            // its own frame.
            const previous = items.at(-1);
            if (previous?.kind === 'para' && isFigureOnly(previous)) {
                const figures = previous.inlines.filter(isInFlowFigure);
                const last = figures.at(-1);
                const caption = last?.attrs?.['layout']
                    ? !!item.frame && item.frame === previous.frame && isCaptionLike(item)
                    : !item.empty && !item.list && !item.task && (item.role.kind === 'caption' || !!item.captionLook);
                if (caption && last?.attrs && figures.length === 1 && !last.attrs['caption']) {
                    last.attrs['caption'] = inlineText(item.inlines);
                    // The space below the caption is the figure's now.
                    const { spaceAfter, baseAfter } = item.format ?? {};
                    previous.format = { ...previous.format, spaceAfter, baseAfter };
                    continue;
                }
            }
            if (item.role.kind === 'structural' || (item.hairline && item.empty && item.role.kind !== 'hr')) {
                items.push({ kind: 'boundary' });
                continue;
            }
            if (item.role.kind === 'hr') {
                items.push({ kind: 'hr', indent: item.indLeft });
                continue;
            }
        }
        if (floats.length > 0) {
            items.push(paraOf(floats));
            floats = [];
        }
        items.push(item);
    }
    if (floats.length > 0) items.push(paraOf(floats));
    // Word ends a cell or the body with a paragraph after a table; it holds nothing of the document's.
    const last = items.at(-1);
    if (last?.kind === 'para' && last.empty && !last.list && !last.task && items.at(-2)?.kind === 'table') items.pop();
    return items;
}

export function paraOf(inlines: JSONContent[]): ParagraphItem {
    return {
        kind: 'para',
        role: { kind: 'paragraph' },
        inlines,
        textAlign: null,
        continued: false,
        indLeft: 0,
        quote: 0,
        empty: false,
        small: false,
        hairline: false,
    };
}

// The writer indents a quote or code in a list item from the item's text, so its depth counts from there and it stays
// in the item. A quote's list items carry the list's indent too, so their depth is the numbering level's base.
function assignQuotes(items: Item[]): void {
    // The open list items, outermost first: a block goes in the innermost it sits in, and closes those inside.
    const opens: ParagraphItem[] = [];
    const closeTo = (host: ParagraphItem | undefined) => {
        opens.length = host ? opens.indexOf(host) + 1 : 0;
    };
    let previous: ParagraphItem | undefined;
    let plain = 0;
    for (const item of items) {
        if (item.kind === 'table' || item.kind === 'hr') {
            const host = itemPast(opens, item.indent);
            blockDepth(item, host, previous);
            closeTo(host);
            if (!item.quote) previous = undefined;
            continue;
        }
        if (item.kind !== 'para') continue;
        // A quoted item's depth by where the writer sets its number or checkbox.
        let counted: number | undefined;
        if (item.list || item.task) {
            for (let open = opens.at(-1); open && !nestsUnder(item, open.indLeft, !!open.task); open = opens.at(-1))
                opens.pop();
            if (item.quote > 0) {
                // Whole quotes past an open item's text: a quote in that item holds it.
                const at = item.numberAt ?? item.indLeft;
                const host = itemPast(opens, at);
                counted = item.list ? listDepth(item.list) : taskDepth(at, host);
                if (counted !== undefined) item.quote = counted;
                if (counted !== undefined && host && counted > host.quote) item.inItem = host;
            }
            // As placeItem nests no deeper than Word's levels: a hostile indent nests each item under the last.
            if (opens.length === LIST_LEVELS) opens.pop();
            opens.push(item);
        } else if (item.role.kind === 'code') closeTo(codeDepth(item, opens, previous));
        else {
            // A quote in an item sits whole quotes past its text, past the quotes the item itself sits in.
            const host = item.quote > 0 ? itemPast(opens, item.indLeft) : itemUnder(opens, item.indLeft);
            const depth = host && item.quote > 0 ? quotesPast(item.indLeft, host.indLeft) : undefined;
            if (host && depth) {
                item.quote = host.quote + depth;
                item.inItem = host;
            } else if (host && host.quote > 0 && depth === 0) {
                // At a quoted item's text it goes on with the item, in its quotes.
                item.quote = host.quote;
                item.inItem = host.inItem;
            }
            if (!item.continued && !item.empty) closeTo(host);
        }
        item.quote = Math.min(item.quote, MAX_QUOTE_DEPTH);
        if (item.quote > 0 && counted === undefined) {
            if (item.list || item.task || item.continued) item.quote = Math.min(item.quote, Math.max(1, plain));
            else if (item.inItem === undefined) plain = item.quote;
        }
        previous = item;
    }
}

// The writer numbers a level from a base, the quotes' indent around the list, its hanging indent per level past it; a
// base off a quote's text is another editor's.
function listDepth(list: NonNullable<ParagraphItem['list']>): number | undefined {
    const depth = quotesPast((list.pPr.indLeft ?? 0) + (list.pPr.indFirst ?? 0) * (list.ilvl + 1), 0);
    return depth || undefined;
}

// The quotes an indent sits past a container's text, a quote's indent each as the writer sets them; none off a whole one.
function quotesPast(indent: number, container: number): number | undefined {
    const depth = Math.round((indent - container) / QUOTE_LOOK.indent);
    return depth >= 0 && Math.abs(indent - container - depth * QUOTE_LOOK.indent) <= INDENT_TOLERANCE
        ? depth
        : undefined;
}

// The writer sets a checkbox at its container's text, a quote's indent per quote past the item it sits in.
function taskDepth(checkbox: number, open: ParagraphItem | undefined): number | undefined {
    const depth = quotesPast(checkbox, open?.indLeft ?? 0);
    if (depth === undefined) return undefined;
    return (open?.quote ?? 0) + depth || undefined;
}

// The writer indents a table or a rule to its container's text, a quote's indent per quote past the item it sits in.
// Nothing else marks it, so it joins a deeper quote only after a paragraph in it.
function blockDepth(
    block: Item & { kind: 'hr' | 'table' },
    host: ParagraphItem | undefined,
    previous: ParagraphItem | undefined,
): void {
    const depth = quotesPast(block.indent, host?.indLeft ?? 0);
    if (depth === undefined) return;
    const quote = (host?.quote ?? 0) + depth;
    // The quotes open around the previous paragraph, outside its item where the block has no host.
    const open = host
        ? previous?.inItem === host
            ? previous.quote
            : host.quote
        : (previous?.inItem?.quote ?? previous?.quote ?? 0);
    if (depth === 0 || quote <= open) block.quote = quote;
}

// The writer sets a code box its own indent in from its container, and each quote around it a quote's indent in from
// the margin or the item's text, past the item's own quotes; other editors indent code as text, so another indent nests
// it only right after a quote, in that quote.
function codeDepth(
    code: ParagraphItem,
    opens: ParagraphItem[],
    previous: ParagraphItem | undefined,
): ParagraphItem | undefined {
    const box = code.indLeft - CODE_BLOCK_LOOK.indent;
    const item = itemPast(opens, box);
    const depth = quotesPast(box, item?.indLeft ?? 0);
    if (code.boxed && depth !== undefined) {
        code.indLeft = box;
        code.quote = (item?.quote ?? 0) + depth;
        code.inItem = item && depth > 0 ? item : undefined;
        return item;
    }
    const container = itemUnder(opens, box)?.indLeft ?? 0;
    if (box - container >= QUOTE_LOOK.indent / 2 && previous && previous.quote > 0) {
        code.quote = previous.quote;
        code.inItem = previous.inItem;
    }
    return itemUnder(opens, code.indLeft);
}

// The innermost open item whose text an indent is at or right of.
function itemUnder(opens: ParagraphItem[], indent: number): ParagraphItem | undefined {
    return opens.findLast((open) => indentedUnder(indent, open.indLeft));
}

// The innermost open item an indent sits at or whole quotes past, as the writer sets a block in it.
function itemPast(opens: ParagraphItem[], indent: number): ParagraphItem | undefined {
    return opens.findLast((open) => quotesPast(indent, open.indLeft) !== undefined);
}

// A break or boundary sits in the shallower of the quotes around it; a table or a rule outside a quote ends it.
function depths(items: Item[]): number[] {
    const nearest = (order: Item[]) => {
        let quote = 0;
        return order.map((item) => {
            const before = quote;
            if (item.kind === 'para') quote = item.quote;
            else if (item.kind === 'hr' || item.kind === 'table') quote = item.quote ?? 0;
            return before;
        });
    };
    const before = nearest(items);
    const after = nearest([...items].reverse()).reverse();
    return items.map((item, index) => {
        if (item.kind === 'para') return item.quote;
        if (item.kind === 'hr' || item.kind === 'table') return item.quote ?? 0;
        if (item.kind === 'break' || item.kind === 'boundary') return Math.min(before[index] ?? 0, after[index] ?? 0);
        return 0;
    });
}

// The next item past breaks and boundaries, looked up once rather than scanned for at every break.
function nextPast(items: Item[]): (Item | undefined)[] {
    const next: (Item | undefined)[] = [];
    for (let index = items.length - 1, ahead: Item | undefined; index >= 0; index--) {
        next[index] = ahead;
        const item = items[index];
        if (item && item.kind !== 'break' && item.kind !== 'boundary') ahead = item;
    }
    return next;
}

function buildLevel(items: Item[], depth: number): JSONContent[] {
    const out: Item[] = [];
    let quoted: Item[] = [];
    const flushQuote = () => {
        if (quoted.length === 0) return;
        const content = buildLevel(quoted, depth + 1);
        const [first] = quoted;
        const itemAt =
            first?.kind === 'para' && first.inItem?.quote === depth ? (first.numberAt ?? first.indLeft) : undefined;
        if (content.length > 0) out.push({ kind: 'block', node: { type: 'blockquote', content }, itemAt });
        quoted = [];
    };
    const itemDepths = depths(items);
    const next = nextPast(items);
    // The writer's Spacer between two boxes stands in their quote; after code, only before a box of the code's container.
    const isBox = (index: number) => {
        const near = items[index];
        const nearDepth = itemDepths[index] ?? 0;
        return nearDepth > depth + 1 || near?.kind === 'table' || (near?.kind === 'para' && near.role.kind === 'code');
    };
    const betweenBoxes = (index: number) => {
        const before = items[index - 1];
        const after = items[index + 1];
        if (!isBox(index - 1) || !isBox(index + 1)) return false;
        if (before?.kind !== 'para' || (itemDepths[index - 1] ?? 0) > depth + 1 || after?.kind !== 'para') return true;
        const container =
            (after.numberAt ?? after.indLeft) - QUOTE_LOOK.indent * ((itemDepths[index + 1] ?? 0) - depth - 1);
        return Math.abs(before.indLeft - container) <= INDENT_TOLERANCE;
    };
    // A quote in an item above starts a quote of its own, one per item, at the depth the item sits at.
    const inItem = (entry: Item | undefined) =>
        entry?.kind === 'para' && entry.inItem?.quote === depth ? entry.inItem : undefined;
    for (const [index, item] of items.entries()) {
        const itemDepth = itemDepths[index] ?? 0;
        if (item.kind === 'boundary' && itemDepth === depth + 1 && !betweenBoxes(index)) {
            flushQuote();
            continue;
        }
        const [first] = quoted;
        // The writer's page break sits at the margin, so between quotes of two items it stands outside both.
        const following = next[index];
        const parts =
            item.kind === 'break' &&
            first?.kind === 'para' &&
            following?.kind === 'para' &&
            inItem(first) !== inItem(following);
        if (itemDepth > depth && !parts) {
            if (item.kind === 'para' && first?.kind === 'para' && inItem(first) !== inItem(item)) flushQuote();
            quoted.push(item);
            continue;
        }
        flushQuote();
        out.push(item);
    }
    flushQuote();
    return buildFlow(out);
}

type Open = {
    list: JSONContent;
    item: JSONContent;
    kind: 'bulletList' | 'orderedList' | 'taskList';
    key: string;
    ilvl: number;
    indent: number;
    number: number;
};

function buildFlow(items: Item[]): JSONContent[] {
    const blocks: JSONContent[] = [];
    const stack: Open[] = [];
    let code: { language: string | null; lines: string[]; host: Open | undefined } | undefined;
    const flushCode = () => {
        if (!code) return;
        const text = code.lines.join('\n');
        (code.host?.item.content ?? blocks).push({
            type: 'codeBlock',
            attrs: { language: code.language },
            content: text ? [{ type: 'text', text }] : [],
        });
        code = undefined;
    };
    const closeLists = (to = 0) => {
        while (stack.length > to) {
            const open = stack.pop();
            if (open && stack.length === 0) blocks.push(open.list);
        }
    };
    // The innermost open item whose text an indent is at or right of, or, for a quote, whole quotes past.
    const hostAt = (indent: number) => stack.findLast((open) => indentedUnder(indent, open.indent));
    const quoteHost = (indent: number) => stack.findLast((open) => quotesPast(indent, open.indent) !== undefined);
    const next = nextPast(items);
    // The item the block past a break goes on in holds the break.
    const breakHost = (index: number): Open | undefined => {
        const following = next[index];
        const top = stack.at(-1);
        if (!following || !top) return undefined;
        if (following.kind === 'hr' || following.kind === 'table') return hostAt(following.indent);
        if (following.kind === 'block') return following.itemAt === undefined ? undefined : quoteHost(following.itemAt);
        if (following.kind !== 'para') return undefined;
        const { list } = following;
        if (following.task || list) {
            const joins = following.task
                ? stack.some(
                      (open) =>
                          open.kind === 'taskList' && Math.abs(open.indent - following.indLeft) <= INDENT_TOLERANCE,
                  )
                : stack.some((open) => open.key === list?.key);
            return joins || nestsUnder(following, top.indent, top.kind === 'taskList') ? top : undefined;
        }
        if (following.continued) return top;
        return following.empty ? undefined : hostAt(following.indLeft);
    };

    // Within the open lists: the next is an item of one of them, or a paragraph at the open text, which goes on with it.
    const betweenItems = (index: number): boolean => {
        const following = next[index];
        const top = stack.at(-1);
        if (following?.kind !== 'para' || !top) return false;
        if (following.task) return stack.some((open) => open.kind === 'taskList');
        if (following.list) return stack.some((open) => open.key === following.list?.key);
        return following.role.kind === 'paragraph' && !following.empty && indentedUnder(following.indLeft, top.indent);
    };

    for (const [index, item] of items.entries()) {
        if (item.kind === 'boundary') {
            flushCode();
            continue;
        }
        if (item.kind === 'para' && item.role.kind === 'code' && !item.list) {
            const host = hostAt(item.indLeft);
            if (code && (code.language !== item.role.language || code.host !== host)) flushCode();
            closeLists(host ? stack.indexOf(host) + 1 : 0);
            code ??= { language: item.role.language, lines: [], host };
            code.lines.push(inlineText(item.inlines.filter((node) => !isFigureFrameNode(node.type))));
            continue;
        }
        flushCode();
        if (item.kind === 'break') {
            const host = breakHost(index);
            if (host) {
                host.item.content?.push({ type: 'pageBreak' });
                continue;
            }
            closeLists();
            blocks.push({ type: 'pageBreak' });
            continue;
        }
        if (item.kind === 'hr' || item.kind === 'table') {
            const block = item.kind === 'hr' ? { type: 'horizontalRule' } : item.node;
            const host = hostAt(item.indent);
            if (host) {
                closeLists(stack.indexOf(host) + 1);
                numberWithin(block, stack.filter((open) => open.kind === 'orderedList').length);
                host.item.content?.push(block);
                continue;
            }
            closeLists();
            blocks.push(block);
            continue;
        }
        if (item.kind === 'block') {
            const host = item.itemAt === undefined ? undefined : quoteHost(item.itemAt);
            if (host) {
                const around = stack.slice(0, stack.indexOf(host) + 1);
                numberWithin(item.node, around.filter((open) => open.kind === 'orderedList').length);
                host.item.content?.push(item.node);
                continue;
            }
            closeLists();
            blocks.push(item.node);
            continue;
        }
        if (item.kind === 'float') continue;
        if (item.list || item.task) {
            placeItem(item, textblockOf(item, undefined), stack, closeLists);
            continue;
        }
        // The writer clears an item's wrapped figure with a break, which a Google Docs re-save leaves bare.
        if (isBreakOnly(item) && breakHost(index) && holdsWrapped(stack.at(-1)?.item)) continue;
        if (stack.length > 0) {
            // A blank line between two items of one list stays in the item above, so the list stays one.
            const host =
                item.continued || (item.empty && item.role.kind === 'paragraph' && betweenItems(index))
                    ? stack.at(-1)
                    : item.empty
                      ? undefined
                      : hostAt(item.indLeft);
            if (host) {
                closeLists(stack.indexOf(host) + 1);
                host.item.content?.push(textblockOf(item, host.indent));
                continue;
            }
        }
        closeLists();
        // The space Eigen draws above it anyway: none at the top, as the writer writes a first heading, and below a
        // block that ends in a table the gap the writer starts it with.
        const above = blocks.length === 0 ? 0 : gapBelowTable(blocks.at(-1));
        blocks.push(textblockOf(item, 0, above, Math.max(above ?? 0, spaceBelow(items[index - 1]))));
    }
    flushCode();
    closeLists();
    return blocks;
}

function isBreakOnly(para: ParagraphItem): boolean {
    return (
        para.inlines.some((node) => node.type === 'hardBreak') &&
        para.inlines.every((node) => node.type === 'hardBreak' || isWhitespace(node))
    );
}

function holdsWrapped(item: JSONContent | undefined): boolean {
    return !!item?.content?.some((block) =>
        block.content?.some(
            (node) => isFigureFrameNode(node.type) && String(node.attrs?.['layout']).startsWith('wrap'),
        ),
    );
}

// The containers whose last block can be a table, with the margin the writer gives their last block.
const CONTAINER_MARGINS = new Map([
    ['bulletList', BLOCK_MARGINS.ul],
    ['taskList', BLOCK_MARGINS.ul],
    ['orderedList', BLOCK_MARGINS.ol],
    ['blockquote', BLOCK_MARGINS.blockquote],
    ['listItem', 0],
    ['taskItem', 0],
]);

// The space a paragraph leaves below it as the file writes it, in twips.
function spaceBelow(item: Item | undefined): number {
    const after = item?.kind === 'para' ? (item.format?.spaceAfter ?? item.format?.baseAfter) : undefined;
    return after === undefined ? 0 : ptToTwips(after);
}

// A table holds no space after, so the writer starts the block below one with its margin, or with the larger margin of
// a list or quote it ends, as withAfter gives that to the table.
function gapBelowTable(block: JSONContent | undefined): number | undefined {
    if (block?.type === 'table') return TABLE_MARGIN;
    const margin = CONTAINER_MARGINS.get(block?.type ?? '');
    const inner = margin === undefined ? undefined : gapBelowTable(block?.content?.at(-1));
    return inner === undefined ? undefined : Math.max(inner, margin ?? 0);
}

// An unnumbered paragraph indented to an item's text continues the item; at no indent it ends the list.
function indentedUnder(indent: number, itemIndent: number): boolean {
    return indent > 0 && itemIndent > 0 && indent >= itemIndent - INDENT_TOLERANCE;
}

// Across lists an item nests by where its number starts, at or right of the open item's text; a task by its indent.
function nestsUnder(para: ParagraphItem, text: number, inTask: boolean): boolean {
    return para.numberAt !== undefined && !inTask
        ? para.numberAt >= text - INDENT_TOLERANCE
        : para.indLeft > text + INDENT_TOLERANCE;
}

// Its format where Eigen draws no container around it: an item's, a quote's or a paragraph's in an item take their
// spacing from it, as the writer writes it, and list and quote nesting is the indent's structure. Only an indent past
// the text of the item it lands in is its own. Eigen draws a space above anyway, in twips, under a table: the writer
// adds a space before to it, so only what passes it is the paragraph's, and none where that is its style's or the
// Normal's.
function formatOf(para: ParagraphItem, edge: number | undefined, above?: number): Record<string, number> {
    const { indent, format } = para;
    const past = indent && edge !== undefined && para.quote === 0 ? indent.left - edge : undefined;
    const before = format?.spaceBefore;
    const own = above === undefined || before === undefined ? before : twipsToPt(ptToTwips(before) - above);
    // At the top the writer writes none, so only a space past it is the paragraph's; under a table an explicit none is.
    const kept = own !== undefined && (own > 0 || (own === 0 && (above ?? 0) > 0)) && own !== format?.baseBefore;
    const spaceBefore = above === undefined || kept ? own : undefined;
    return readParagraphFormat({
        lineSpacing: format?.lineSpacing,
        ...(edge === 0 && para.quote === 0 && { spaceBefore, spaceAfter: format?.spaceAfter }),
        ...(past !== undefined && {
            indentLeft: past > INDENT_TOLERANCE ? twipsToPt(past) : undefined,
            indentRight: indent && indent.right > 0 ? twipsToPt(indent.right) : undefined,
            indentFirstLine: indent?.firstLine ? twipsToPt(indent.firstLine) : undefined,
        }),
    });
}

// The figure draws its own margin above it, so only the space past that margin is the paragraph's. A heading the writer
// split at its figure keeps its space above that way. Readers collapse a paragraph's space above with the one the block
// above leaves below it, so a space no larger than that one, `below` in twips, is the block above's. A plain paragraph
// draws its style's space above anyway, so a space no larger than that one is no space of its own either.
function figureSpaceBefore(para: ParagraphItem, below: number): number | undefined {
    const before = para.format?.spaceBefore;
    const past = before === undefined ? 0 : Math.round(ptToTwips(before) - FIGURE_MARGIN.top);
    const base = para.role.kind === 'paragraph' ? Math.round(ptToTwips(para.format?.baseBefore ?? 0)) : 0;
    return past > Math.max(below, base) ? twipsToPt(past) : undefined;
}

function textblockOf(para: ParagraphItem, edge: number | undefined, above?: number, below = 0): JSONContent {
    const { textAlign, inlines: content } = para;
    if (isFigureOnly(para)) {
        for (const figure of content) {
            if (isFigureFrameNode(figure.type) && figure.attrs && !figure.attrs['layout'] && !figure.attrs['alignment'])
                figure.attrs['alignment'] = textAlign === 'center' || textAlign === 'right' ? textAlign : 'left';
        }
        const spaceBefore = edge === 0 && para.quote === 0 ? figureSpaceBefore(para, below) : undefined;
        return spaceBefore === undefined
            ? { type: 'paragraph', content }
            : { type: 'paragraph', attrs: { spaceBefore }, content };
    }
    const attrs = { textAlign, ...formatOf(para, edge, above) };
    if (para.role.kind === 'heading') return { type: 'heading', attrs: { level: para.role.level, ...attrs }, content };
    if (para.role.kind === 'title' || para.role.kind === 'subtitle') return { type: para.role.kind, attrs, content };
    return { type: 'paragraph', attrs, content };
}

// A list that draws as an untyped one does at its depth stores no type, so it numbers by depth as Google's 1. a. i.
// does; any other keeps its own, a nested decimal one '1'. A format Eigen has no type for draws decimal, as Word's would.
function listType(para: ParagraphItem, stack: Open[]): string | null {
    const type = LIST_TYPES.get(para.list?.format ?? '') ?? '1';
    const numbered = stack.filter((open) => open.kind === 'orderedList').length;
    return LIST_FORMATS.get(type) === untypedListFormat(numbered) ? null : type;
}

// A table's cells and a quote were read as flows of their own, so a list in one took its type at its depth there; in
// the list item that holds the table or quote, `numbered` lists more surround it.
function numberWithin(node: JSONContent, numbered: number, depth = 0): void {
    if (numbered === 0) return;
    const ordered = node.type === 'orderedList';
    if (ordered && node.attrs) {
        const type = node.attrs['type'];
        const format = typeof type === 'string' ? LIST_FORMATS.get(type) : untypedListFormat(depth);
        node.attrs['type'] =
            format === untypedListFormat(depth + numbered) ? null : (LIST_TYPES.get(format ?? '') ?? null);
    }
    for (const child of node.content ?? []) numberWithin(child, numbered, depth + (ordered ? 1 : 0));
}

// Lists nest by Word's level within one list; across lists by where the number starts, at or right of the open item's
// text, and tasks by indent. A number that doesn't follow starts a new list.
function placeItem(para: ParagraphItem, textblock: JSONContent, stack: Open[], closeLists: (to: number) => void): void {
    // An item opens on a paragraph: a checkbox in a heading makes a task of the heading's text.
    const paragraph: JSONContent =
        textblock.type === 'paragraph'
            ? textblock
            : {
                  type: 'paragraph',
                  attrs: { textAlign: para.textAlign, ...formatOf(para, undefined) },
                  content: textblock.content,
              };
    const kind = para.task ? 'taskList' : para.list?.ordered ? 'orderedList' : 'bulletList';
    const key = para.task ? 'task' : (para.list?.key ?? '');
    const ilvl = para.list?.ilvl ?? 0;
    const indent = para.indLeft;
    const number = para.list?.number ?? 1;
    const item: JSONContent = para.task
        ? { type: 'taskItem', attrs: { checked: para.task.checked }, content: [paragraph] }
        : { type: 'listItem', content: [paragraph] };
    while (stack.length > 0) {
        const top = stack.at(-1);
        if (!top) break;
        const sameList = top.key === key && top.kind === kind && !para.task;
        if (sameList && top.ilvl > ilvl) {
            closeLists(stack.length - 1);
            continue;
        }
        if (sameList && top.ilvl === ilvl) {
            if (kind === 'orderedList' && number !== top.number + 1) {
                closeLists(stack.length - 1);
                break;
            }
            top.list.content?.push(item);
            top.item = item;
            top.number = number;
            return;
        }
        if (para.task && top.kind === 'taskList' && Math.abs(top.indent - indent) <= INDENT_TOLERANCE) {
            top.list.content?.push(item);
            top.item = item;
            return;
        }
        const deeper = sameList ? top.ilvl < ilvl : nestsUnder(para, top.indent, top.kind === 'taskList');
        // No deeper than Word's levels: lists of other definitions nest by indent, which a hostile file can deepen.
        if (deeper && stack.length < LIST_LEVELS) break;
        closeLists(stack.length - 1);
        if (deeper) break;
    }
    const attrs = kind === 'orderedList' ? { start: number, type: listType(para, stack) } : undefined;
    const level: Open = {
        list: { type: kind, ...(attrs && { attrs }), content: [item] },
        item,
        kind,
        key,
        ilvl,
        indent,
        number,
    };
    stack.at(-1)?.item.content?.push(level.list);
    stack.push(level);
}
