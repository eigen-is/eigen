import type { JSONContent } from '@tiptap/core';
import { DEFAULT_PAGE_SETUP, pagePx } from '@workspace/lib/docs/eigendoc';
import { LIST_LEVELS, LIST_TYPES } from '../../core/ooxml';
import { CODE_BLOCK_LOOK, QUOTE_LOOK } from '../../export/doc/looks';
import type { ListRef } from './numbering';
import type { Role } from './styles';

// Items → blocks: floats and captions join their paragraph, quotes nest by depth, lists by level, code lines join.

export type Para = {
    kind: 'para';
    role: Role;
    inlines: JSONContent[];
    textAlign: string | null;
    list?: ListRef & { ilvl: number };
    task?: { checked: boolean };
    // A half after a page break, which continues its item rather than numbering again.
    continued: boolean;
    indLeft: number;
    quote: number;
    // A quote inside the list item above it.
    inItem?: boolean;
    // The writer's code box, whose indent counts its quotes.
    boxed?: boolean;
    // A tracked deletion of the mark: accepted, the content joins the next paragraph.
    joinsNext?: boolean;
    // The first inline is a numbered heading's number.
    labelled?: boolean;
    empty: boolean;
    small: boolean;
    hairline: boolean;
};

export type Item =
    | Para
    | { kind: 'break' }
    | { kind: 'boundary' }
    | { kind: 'hr'; indent: number }
    | { kind: 'table'; node: JSONContent; indent: number }
    | { kind: 'block'; node: JSONContent; inItem?: boolean }
    | { kind: 'float'; figure: JSONContent };

const PAGE = pagePx(DEFAULT_PAGE_SETUP);

// The editor's text column: no image or table column imports wider.
export const COLUMN_PX = Math.floor(PAGE.width - PAGE.margin.left - PAGE.margin.right);

// Deeper quotes join the deepest, so a hostile indent can't nest without end.
export const MAX_QUOTE_DEPTH = 8;

const INDENT_TOLERANCE = 60;

const ASCII_WHITESPACE = /^[ \t\r\n]*$/;

export function isWhitespace(node: JSONContent): boolean {
    return node.type === 'text' && ASCII_WHITESPACE.test(node.text ?? '');
}

export function build(raw: Item[]): JSONContent[] {
    const items = attachFloatsAndCaptions(joinDeletedMarks(raw));
    assignQuotes(items);
    return buildLevel(items, 0);
}

export function textOf(nodes: JSONContent[]): string {
    return nodes.map((node) => (node.type === 'hardBreak' ? '\n' : (node.text ?? ''))).join('');
}

// Word's Caption style, or a short line of small text, as Google Docs flattens the style.
export function isCaptionLike(para: Para): boolean {
    return !para.empty && (para.role.kind === 'caption' || (para.small && !para.list && !para.task));
}

export function isFigureOnly(para: Para): boolean {
    return (
        para.inlines.some((node) => node.type === 'figure') &&
        para.inlines.every((node) => node.type === 'figure' || isWhitespace(node))
    );
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

// The joined paragraph is the next one, with its own properties: its mark is the one that stays.
function joinDeletedMarks(raw: Item[]): Item[] {
    return raw.filter((item, index) => {
        const next = raw[index + 1];
        if (item.kind !== 'para' || !item.joinsNext || next?.kind !== 'para') return true;
        const at = next.labelled ? 1 : 0;
        next.inlines = [...next.inlines.slice(0, at), ...item.inlines, ...next.inlines.slice(at)];
        next.empty &&= item.empty;
        return false;
    });
}

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
            if (
                floats.length > 0 &&
                (item.role.kind === 'paragraph' || item.role.kind === 'heading' || item.role.kind === 'taskDone')
            ) {
                // After a numbered heading's number, as joined text goes.
                const at = item.labelled ? 1 : 0;
                item.inlines = [...item.inlines.slice(0, at), ...floats, ...item.inlines.slice(at)];
                item.empty = false;
                floats = [];
            }
            const previous = items.at(-1);
            if (isCaptionLike(item) && previous?.kind === 'para' && isFigureOnly(previous)) {
                const figures = previous.inlines.filter((node) => node.type === 'figure');
                const last = figures.at(-1);
                if (last?.attrs && figures.length === 1 && !last.attrs['caption']) {
                    last.attrs['caption'] = textOf(item.inlines);
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

function paraOf(inlines: JSONContent[]): Para {
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
// in the item. A quote's list items carry the list's indent too, so they sit at the depth of the quote around them.
function assignQuotes(items: Item[]): void {
    let open: Para | undefined;
    let previous: Para | undefined;
    let plain = 0;
    for (const item of items) {
        // A table or rule ends a quote (depths); a page break doesn't.
        if (item.kind === 'table' || item.kind === 'hr') {
            previous = undefined;
            if (!(open && indentedUnder(item.indent, open.indLeft))) open = undefined;
        }
        if (item.kind !== 'para') continue;
        if (item.list || item.task) open = item;
        else if (item.role.kind === 'code') {
            codeDepth(item, open, previous);
            if (!(open && indentedUnder(item.indLeft, open.indLeft))) open = undefined;
        } else if (open && item.quote > 0 && item.indLeft > open.indLeft + INDENT_TOLERANCE) {
            item.quote = Math.max(1, Math.round((item.indLeft - open.indLeft) / QUOTE_LOOK.indent));
            item.inItem = true;
        } else if (!item.continued && !item.empty) open = undefined;
        item.quote = Math.min(item.quote, MAX_QUOTE_DEPTH);
        if (item.quote > 0) {
            if (item.list || item.task || item.continued) item.quote = Math.min(item.quote, Math.max(1, plain));
            else plain = item.quote;
        }
        previous = item;
    }
}

// The writer sets a code box its own indent in from its container, and each quote around it a quote's indent in from
// the margin or the item's text, past the item's own quotes; other editors indent code as text, so another indent nests
// it only right after a quote, in that quote.
function codeDepth(code: Para, open: Para | undefined, previous: Para | undefined): void {
    const box = code.indLeft - CODE_BLOCK_LOOK.indent;
    const item = open && indentedUnder(box, open.indLeft) ? open : undefined;
    const container = item?.indLeft ?? 0;
    const depth = Math.round((box - container) / QUOTE_LOOK.indent);
    if (code.boxed && depth >= 0 && Math.abs(box - container - depth * QUOTE_LOOK.indent) <= INDENT_TOLERANCE) {
        code.indLeft = box;
        code.quote = (item?.quote ?? 0) + depth;
        code.inItem = !!item && depth > 0;
    } else if (depth > 0 && previous && previous.quote > 0) {
        code.quote = previous.quote;
        code.inItem = previous.inItem;
    }
}

// A break or boundary sits in the shallower of the quotes around it; a table or rule between ends a quote.
function depths(items: Item[]): number[] {
    const nearest = (order: Item[]) => {
        let quote = 0;
        return order.map((item) => {
            const before = quote;
            if (item.kind === 'para') quote = item.quote;
            else if (item.kind === 'table' || item.kind === 'hr') quote = 0;
            return before;
        });
    };
    const before = nearest(items);
    const after = nearest([...items].reverse()).reverse();
    return items.map((item, index) => {
        if (item.kind === 'para') return item.quote;
        if (item.kind === 'break' || item.kind === 'boundary') return Math.min(before[index] ?? 0, after[index] ?? 0);
        return 0;
    });
}

function buildLevel(items: Item[], depth: number): JSONContent[] {
    const out: Item[] = [];
    let quoted: Item[] = [];
    const flushQuote = () => {
        if (quoted.length === 0) return;
        const content = buildLevel(quoted, depth + 1);
        const [first] = quoted;
        if (content.length > 0)
            out.push({
                kind: 'block',
                node: { type: 'blockquote', content },
                inItem: first?.kind === 'para' && first.inItem,
            });
        quoted = [];
    };
    const itemDepths = depths(items);
    for (const [index, item] of items.entries()) {
        const itemDepth = itemDepths[index] ?? 0;
        if (item.kind === 'boundary' && itemDepth === depth + 1) {
            flushQuote();
            continue;
        }
        if (itemDepth > depth) {
            const [first] = quoted;
            if (item.kind === 'para' && first?.kind === 'para' && !!first.inItem !== !!item.inItem) flushQuote();
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
    // The next item past breaks and boundaries, looked up once rather than scanned for at every break.
    const next: (Item | undefined)[] = [];
    for (let index = items.length - 1, ahead: Item | undefined; index >= 0; index--) {
        next[index] = ahead;
        const item = items[index];
        if (item && item.kind !== 'break' && item.kind !== 'boundary') ahead = item;
    }
    const continues = (index: number): boolean => {
        const following = next[index];
        if (following?.kind !== 'para') return false;
        const outer = stack[0];
        return (
            !!following.list ||
            !!following.task ||
            following.continued ||
            (!!outer &&
                following.role.kind === 'paragraph' &&
                !following.empty &&
                indentedUnder(following.indLeft, outer.indent))
        );
    };

    for (const [index, item] of items.entries()) {
        if (item.kind === 'boundary') {
            flushCode();
            continue;
        }
        if (item.kind === 'para' && item.role.kind === 'code' && !item.list) {
            const host = stack.findLast((open) => indentedUnder(item.indLeft, open.indent));
            if (code && (code.language !== item.role.language || code.host !== host)) flushCode();
            closeLists(host ? stack.indexOf(host) + 1 : 0);
            code ??= { language: item.role.language, lines: [], host };
            code.lines.push(textOf(item.inlines.filter((node) => node.type !== 'figure')));
            continue;
        }
        flushCode();
        if (item.kind === 'break') {
            const current = stack.at(-1);
            if (current && continues(index)) {
                current.item.content?.push({ type: 'pageBreak' });
                continue;
            }
            closeLists();
            blocks.push({ type: 'pageBreak' });
            continue;
        }
        if (item.kind === 'hr' || item.kind === 'table') {
            const block = item.kind === 'hr' ? { type: 'horizontalRule' } : item.node;
            const host = stack.findLast((open) => indentedUnder(item.indent, open.indent));
            if (host) {
                closeLists(stack.indexOf(host) + 1);
                host.item.content?.push(block);
                continue;
            }
            closeLists();
            blocks.push(block);
            continue;
        }
        if (item.kind === 'block') {
            const host = item.inItem ? stack.at(-1) : undefined;
            if (host) {
                host.item.content?.push(item.node);
                continue;
            }
            closeLists();
            blocks.push(item.node);
            continue;
        }
        if (item.kind === 'float') continue;
        const node = textblockOf(item);
        if (item.list || item.task) {
            placeItem(item, node, stack, blocks);
            continue;
        }
        if (stack.length > 0 && item.role.kind !== 'heading') {
            // A blank line between two items of one list stays in the item above, so the list stays one.
            const host =
                item.continued || (item.empty && item.role.kind === 'paragraph' && continues(index))
                    ? stack.at(-1)
                    : stack.findLast((open) => !item.empty && indentedUnder(item.indLeft, open.indent));
            if (host) {
                closeLists(stack.indexOf(host) + 1);
                host.item.content?.push(node);
                continue;
            }
        }
        closeLists();
        blocks.push(node);
    }
    flushCode();
    closeLists();
    return blocks;
}

// An unnumbered paragraph indented to an item's text continues the item; at no indent it ends the list.
function indentedUnder(indent: number, itemIndent: number): boolean {
    return indent > 0 && itemIndent > 0 && indent >= itemIndent - INDENT_TOLERANCE;
}

function textblockOf(para: Para): JSONContent {
    const { textAlign, inlines: content } = para;
    if (isFigureOnly(para)) {
        for (const figure of content) {
            if (figure.type === 'figure' && figure.attrs && !figure.attrs['layout'] && !figure.attrs['alignment'])
                figure.attrs['alignment'] = textAlign === 'center' || textAlign === 'right' ? textAlign : 'left';
        }
        return { type: 'paragraph', content };
    }
    if (para.role.kind === 'heading') return { type: 'heading', attrs: { level: para.role.level, textAlign }, content };
    return { type: 'paragraph', attrs: { textAlign }, content };
}

// Lists nest by Word's level within one list, by indent across lists and tasks; a number that doesn't follow starts a new list.
function placeItem(para: Para, textblock: JSONContent, stack: Open[], blocks: JSONContent[]): void {
    // An item opens on a paragraph: a checkbox in a heading makes a task of the heading's text.
    const paragraph: JSONContent =
        textblock.type === 'paragraph'
            ? textblock
            : { type: 'paragraph', attrs: { textAlign: para.textAlign }, content: textblock.content };
    const kind = para.task ? 'taskList' : para.list?.ordered ? 'orderedList' : 'bulletList';
    const key = para.task ? 'task' : (para.list?.key ?? '');
    const ilvl = para.list?.ilvl ?? 0;
    const indent = para.indLeft;
    const number = para.list?.number ?? 1;
    const item: JSONContent = para.task
        ? { type: 'taskItem', attrs: { checked: para.task.checked }, content: [paragraph] }
        : { type: 'listItem', content: [paragraph] };
    const pop = () => {
        const popped = stack.pop();
        if (popped && stack.length === 0) blocks.push(popped.list);
    };
    while (stack.length > 0) {
        const top = stack.at(-1);
        if (!top) break;
        const sameList = top.key === key && top.kind === kind && !para.task;
        if (sameList && top.ilvl > ilvl) {
            pop();
            continue;
        }
        if (sameList && top.ilvl === ilvl) {
            if (kind === 'orderedList' && number !== top.number + 1) {
                pop();
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
        const deeper = sameList ? top.ilvl < ilvl : indent > top.indent + INDENT_TOLERANCE;
        // No deeper than Word's levels: lists of other definitions nest by indent, which a hostile file can deepen.
        if (deeper && stack.length < LIST_LEVELS) break;
        pop();
        if (deeper) break;
    }
    const attrs =
        kind === 'orderedList' ? { start: number, type: LIST_TYPES.get(para.list?.format ?? '') ?? null } : undefined;
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
