import type { JSONContent } from '@tiptap/core';
import { DEFAULT_PAGE_SETUP, pagePx } from '@workspace/lib/docs/eigendoc';
import { LIST_LEVELS, LIST_TYPES } from '../../core/ooxml';
import { CODE_BLOCK_LOOK, QUOTE_LOOK } from '../../document/looks';
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
    // Where an item's number or checkbox starts, which says whether a list of another definition nests under the open
    // item.
    numberAt?: number;
    quote: number;
    // A quote inside the list item above it: the quote depth that item sits at.
    inItem?: number;
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
};

export type Item =
    | Para
    | { kind: 'break' }
    | { kind: 'boundary' }
    // A rule's or a table's quote: the writer indents either in a quote to the quote's text.
    | { kind: 'hr'; indent: number; quote?: number }
    | { kind: 'table'; node: JSONContent; indent: number; quote?: number }
    // A quote in a list item: where its first line starts, which says which open item holds it.
    | { kind: 'block'; node: JSONContent; itemAt?: number }
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

export function inlineText(nodes: JSONContent[]): string {
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
            // A block figure takes the next line in the Caption style or its look; a wrapped one only a caption in
            // its own frame.
            const previous = items.at(-1);
            if (previous?.kind === 'para' && isFigureOnly(previous)) {
                const figures = previous.inlines.filter((node) => node.type === 'figure');
                const last = figures.at(-1);
                const caption = last?.attrs?.['layout']
                    ? !!item.frame && item.frame === previous.frame && isCaptionLike(item)
                    : !item.empty && !item.list && !item.task && (item.role.kind === 'caption' || !!item.captionLook);
                if (caption && last?.attrs && figures.length === 1 && !last.attrs['caption']) {
                    last.attrs['caption'] = inlineText(item.inlines);
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

export function paraOf(inlines: JSONContent[]): Para {
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
    // The open list items, outermost first: a block goes in the innermost whose text it sits at, and closes those inside.
    const opens: Para[] = [];
    const hostAt = (indent: number) => opens.findLast((open) => indentedUnder(indent, open.indLeft));
    const closeTo = (host: Para | undefined) => {
        opens.length = host ? opens.indexOf(host) + 1 : 0;
    };
    let previous: Para | undefined;
    let plain = 0;
    for (const item of items) {
        if (item.kind === 'table' || item.kind === 'hr') {
            const host = hostAt(item.indent);
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
                const host = opens.findLast((open) => quotesPast(at, open.indLeft) !== undefined);
                counted = item.list ? listDepth(item.list) : taskDepth(at, host);
                if (counted !== undefined) item.quote = counted;
                if (counted !== undefined && host && counted > host.quote) item.inItem = host.quote;
            }
            opens.push(item);
        } else if (item.role.kind === 'code') closeTo(codeDepth(item, hostAt, previous));
        else {
            // A quote in an item sits whole quotes past its text, past the quotes the item itself sits in.
            const host =
                item.quote > 0
                    ? opens.findLast((open) => quotesPast(item.indLeft, open.indLeft) !== undefined)
                    : hostAt(item.indLeft);
            const depth = host && item.quote > 0 ? quotesPast(item.indLeft, host.indLeft) : undefined;
            if (host && depth) {
                item.quote = host.quote + depth;
                item.inItem = host.quote;
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
function listDepth(list: NonNullable<Para['list']>): number | undefined {
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
function taskDepth(checkbox: number, open: Para | undefined): number | undefined {
    const depth = quotesPast(checkbox, open?.indLeft ?? 0);
    if (depth === undefined) return undefined;
    return (open?.quote ?? 0) + depth || undefined;
}

// The writer indents a table or a rule to its container's text, a quote's indent per quote past the item it sits in.
// Nothing else marks it, so it joins a deeper quote only after a paragraph in it.
function blockDepth(block: Item & { kind: 'hr' | 'table' }, host: Para | undefined, previous: Para | undefined): void {
    const depth = quotesPast(block.indent, host?.indLeft ?? 0);
    if (depth === undefined) return;
    const quote = (host?.quote ?? 0) + depth;
    if (depth === 0 || (previous !== undefined && previous.inItem === host?.quote && previous.quote >= quote))
        block.quote = quote;
}

// The writer sets a code box its own indent in from its container, and each quote around it a quote's indent in from
// the margin or the item's text, past the item's own quotes; other editors indent code as text, so another indent nests
// it only right after a quote, in that quote.
function codeDepth(
    code: Para,
    hostAt: (indent: number) => Para | undefined,
    previous: Para | undefined,
): Para | undefined {
    const box = code.indLeft - CODE_BLOCK_LOOK.indent;
    const item = hostAt(box);
    const container = item?.indLeft ?? 0;
    const depth = quotesPast(box, container);
    if (code.boxed && depth !== undefined) {
        code.indLeft = box;
        code.quote = (item?.quote ?? 0) + depth;
        code.inItem = item && depth > 0 ? item.quote : undefined;
    } else if (box - container >= QUOTE_LOOK.indent / 2 && previous && previous.quote > 0) {
        code.quote = previous.quote;
        code.inItem = previous.inItem;
    }
    return hostAt(code.indLeft);
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

function buildLevel(items: Item[], depth: number): JSONContent[] {
    const out: Item[] = [];
    let quoted: Item[] = [];
    const flushQuote = () => {
        if (quoted.length === 0) return;
        const content = buildLevel(quoted, depth + 1);
        const [first] = quoted;
        const itemAt = first?.kind === 'para' && first.inItem === depth ? (first.numberAt ?? first.indLeft) : undefined;
        if (content.length > 0) out.push({ kind: 'block', node: { type: 'blockquote', content }, itemAt });
        quoted = [];
    };
    const itemDepths = depths(items);
    // Code or a deeper quote: the writer's Spacer between two of them stands in the quote around them.
    const isBox = (index: number) => {
        const near = items[index];
        const nearDepth = itemDepths[index] ?? 0;
        return nearDepth > depth + 1 || (near?.kind === 'para' && near.role.kind === 'code');
    };
    for (const [index, item] of items.entries()) {
        const itemDepth = itemDepths[index] ?? 0;
        if (item.kind === 'boundary' && itemDepth === depth + 1 && !(isBox(index - 1) && isBox(index + 1))) {
            flushQuote();
            continue;
        }
        if (itemDepth > depth) {
            const [first] = quoted;
            // A quote in the item above starts a quote of its own, at the depth the item sits at.
            const inItem = (entry: Item | undefined) => entry?.kind === 'para' && entry.inItem === depth;
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
    // The innermost open item whose text an indent is at or right of.
    const hostAt = (indent: number) => stack.findLast((open) => indentedUnder(indent, open.indent));
    // The next item past breaks and boundaries, looked up once rather than scanned for at every break.
    const next: (Item | undefined)[] = [];
    for (let index = items.length - 1, ahead: Item | undefined; index >= 0; index--) {
        next[index] = ahead;
        const item = items[index];
        if (item && item.kind !== 'break' && item.kind !== 'boundary') ahead = item;
    }
    // The item the block past a break goes on in, which holds the break: an item of an open list or nesting under the
    // open item, or a block at an open item's text.
    const breakHost = (index: number): Open | undefined => {
        const following = next[index];
        const top = stack.at(-1);
        if (!following || !top) return undefined;
        if (following.kind === 'hr' || following.kind === 'table') return hostAt(following.indent);
        if (following.kind === 'block') return following.itemAt === undefined ? undefined : hostAt(following.itemAt);
        if (following.kind !== 'para') return undefined;
        const { list } = following;
        if (following.task || list) {
            const joins = following.task
                ? stack.some((open) => open.kind === 'taskList')
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
            code.lines.push(inlineText(item.inlines.filter((node) => node.type !== 'figure')));
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
                host.item.content?.push(block);
                continue;
            }
            closeLists();
            blocks.push(block);
            continue;
        }
        if (item.kind === 'block') {
            const host = item.itemAt === undefined ? undefined : hostAt(item.itemAt);
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
            placeItem(item, node, stack, closeLists);
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

function isBreakOnly(para: Para): boolean {
    return (
        para.inlines.some((node) => node.type === 'hardBreak') &&
        para.inlines.every((node) => node.type === 'hardBreak' || isWhitespace(node))
    );
}

function holdsWrapped(item: JSONContent | undefined): boolean {
    return !!item?.content?.some((block) =>
        block.content?.some((node) => node.type === 'figure' && String(node.attrs?.['layout']).startsWith('wrap')),
    );
}

// An unnumbered paragraph indented to an item's text continues the item; at no indent it ends the list.
function indentedUnder(indent: number, itemIndent: number): boolean {
    return indent > 0 && itemIndent > 0 && indent >= itemIndent - INDENT_TOLERANCE;
}

// Across lists an item nests by where its number starts, at or right of the open item's text; a task by its indent.
function nestsUnder(para: Para, text: number, inTask: boolean): boolean {
    return para.numberAt !== undefined && !inTask
        ? para.numberAt >= text - INDENT_TOLERANCE
        : para.indLeft > text + INDENT_TOLERANCE;
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

// Lists nest by Word's level within one list; across lists by where the number starts, at or right of the open item's
// text, and tasks by indent. A number that doesn't follow starts a new list.
function placeItem(para: Para, textblock: JSONContent, stack: Open[], closeLists: (to: number) => void): void {
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
