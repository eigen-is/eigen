import type { JSONContent } from '@tiptap/core';
import { DEFAULT_PAGE_SETUP, pagePx } from '@workspace/lib/docs/eigendoc';
import { type ListRef, ORDERED_TYPES } from './numbering';
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
    empty: boolean;
    small: boolean;
    hairline: boolean;
};

export type Item =
    | Para
    | { kind: 'break' }
    | { kind: 'boundary' }
    | { kind: 'hr' }
    | { kind: 'table'; node: JSONContent; indent: number }
    | { kind: 'block'; node: JSONContent }
    | { kind: 'float'; figure: JSONContent };

const PAGE = pagePx(DEFAULT_PAGE_SETUP);

// The editor's text column: no image or table column imports wider.
export const COLUMN_PX = Math.floor(PAGE.width - PAGE.margin.left - PAGE.margin.right);

// Deeper quotes join the deepest, so a hostile indent can't nest without end.
export const MAX_QUOTE_DEPTH = 8;

// Word's levels; lists of other definitions nest by indent, which a hostile file can deepen without end.
export const MAX_LIST_DEPTH = 9;

const INDENT_TOLERANCE = 60;

const ASCII_WHITESPACE = /^[ \t\r\n]*$/;

export function isWhitespace(node: JSONContent): boolean {
    return node.type === 'text' && ASCII_WHITESPACE.test(node.text ?? '');
}

export function build(raw: Item[]): JSONContent[] {
    const items = attachFloatsAndCaptions(raw);
    for (const item of items) if (item.kind === 'para') item.quote = Math.min(item.quote, MAX_QUOTE_DEPTH);
    assignBreakDepths(items);
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
                item.inlines = [...floats, ...item.inlines];
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
                items.push({ kind: 'hr' });
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

// A quote's list items carry the list's indent too, so they sit at the depth of the quote around them.
function assignBreakDepths(items: Item[]): void {
    let plain = 0;
    for (const item of items) {
        if (item.kind !== 'para' || item.quote === 0) continue;
        if (item.list || item.task || item.continued) item.quote = Math.min(item.quote, Math.max(1, plain));
        else plain = item.quote;
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
        if (content.length > 0) out.push({ kind: 'block', node: { type: 'blockquote', content } });
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
    let code: { language: string | null; lines: string[] } | undefined;
    const flushCode = () => {
        if (!code) return;
        const text = code.lines.join('\n');
        blocks.push({
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
            if (stack.length > 0) closeLists();
            if (code && code.language !== item.role.language) flushCode();
            code ??= { language: item.role.language, lines: [] };
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
        if (item.kind === 'hr') {
            closeLists();
            blocks.push({ type: 'horizontalRule' });
            continue;
        }
        if (item.kind === 'table') {
            const host = stack.findLast((open) => indentedUnder(item.indent, open.indent));
            if (host) {
                closeLists(stack.indexOf(host) + 1);
                host.item.content?.push(item.node);
                continue;
            }
            closeLists();
            blocks.push(item.node);
            continue;
        }
        if (item.kind === 'block') {
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
        if (deeper && stack.length < MAX_LIST_DEPTH) break;
        pop();
        if (deeper) break;
    }
    const attrs =
        kind === 'orderedList' ? { start: number, type: ORDERED_TYPES[para.list?.format ?? ''] ?? null } : undefined;
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
