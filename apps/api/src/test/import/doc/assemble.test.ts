import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { QUOTE_LOOK } from '../../../lib/export/doc/ooxml';
import { build, type Item, type Para } from '../../../lib/import/doc/assemble';

// Items in, blocks out: the assembly rules without XML.

const ITEM_INDENT = 720;

function para(text: string, extra: Partial<Para> = {}): Para {
    return {
        kind: 'para',
        role: { kind: 'paragraph' },
        inlines: text ? [{ type: 'text', text }] : [],
        textAlign: null,
        continued: false,
        indLeft: 0,
        quote: 0,
        empty: !text,
        small: false,
        hairline: false,
        ...extra,
    };
}

function item(text: string, ilvl = 0, number = 1): Para {
    return para(text, {
        indLeft: ITEM_INDENT * (ilvl + 1),
        list: {
            key: 'list',
            ordered: true,
            format: 'decimal',
            number,
            label: () => `${number}.`,
            suffix: 'tab',
            ilvl,
        },
    });
}

// A paragraph as its text, any other block as its type with its children in brackets.
function outline(node: JSONContent): string {
    if (node.type === 'text') return node.text ?? '';
    const children = node.content ?? [];
    if (node.type === 'paragraph') return children.map(outline).join('');
    return children.length > 0 ? `${node.type}[${children.map(outline).join(' | ')}]` : (node.type ?? '');
}

const assembled = (items: Item[]) => build(items).map(outline);

describe('lists', () => {
    test('items nest by level within one list and keep counting after a nested one', () => {
        expect(assembled([item('One', 0, 1), item('One a', 1, 1), item('Two', 0, 2)])).toEqual([
            'orderedList[listItem[One | orderedList[listItem[One a]]] | listItem[Two]]',
        ]);
    });

    test('a number that does not follow starts a new list', () => {
        expect(assembled([item('One', 0, 1), item('Five', 0, 5)])).toEqual([
            'orderedList[listItem[One]]',
            'orderedList[listItem[Five]]',
        ]);
    });

    test('a page break between two items stays in the first', () => {
        expect(assembled([item('One', 0, 1), { kind: 'break' }, item('Two', 0, 2)])).toEqual([
            'orderedList[listItem[One | pageBreak] | listItem[Two]]',
        ]);
    });

    test('a page break after the last item stands after the list', () => {
        expect(assembled([item('One', 0, 1), { kind: 'break' }, para('After')])).toEqual([
            'orderedList[listItem[One]]',
            'pageBreak',
            'After',
        ]);
    });
});

describe('quotes', () => {
    const quoted = (text: string, indLeft: number, quote = 1) => para(text, { indLeft, quote });

    test('a quote inside a list item stays inside the item, its depth counted from the item', () => {
        const inItem = ITEM_INDENT + QUOTE_LOOK.indent;
        expect(assembled([item('One', 0, 1), quoted('Said', inItem, 3), item('Two', 0, 2)])).toEqual([
            'orderedList[listItem[One | blockquote[Said]] | listItem[Two]]',
        ]);
    });

    test('a quote in the last item and one at the margin after it stay apart', () => {
        const inItem = ITEM_INDENT + QUOTE_LOOK.indent;
        expect(assembled([item('One', 0, 1), quoted('Said', inItem), quoted('After', QUOTE_LOOK.indent)])).toEqual([
            'orderedList[listItem[One | blockquote[Said]]]',
            'blockquote[After]',
        ]);
    });

    test('a quote at the margin after a list ends the list', () => {
        expect(assembled([item('One', 0, 1), quoted('Said', QUOTE_LOOK.indent)])).toEqual([
            'orderedList[listItem[One]]',
            'blockquote[Said]',
        ]);
    });

    test('a page break between two quoted paragraphs stays in the quote', () => {
        expect(
            assembled([quoted('One', QUOTE_LOOK.indent), { kind: 'break' }, quoted('Two', QUOTE_LOOK.indent)]),
        ).toEqual(['blockquote[One | pageBreak | Two]']);
    });
});

describe('blank lines before a page', () => {
    test('a run of empty paragraphs before a break goes, one between text stays', () => {
        expect(
            assembled([para('One'), para(''), para('Two'), para(''), para(''), { kind: 'break' }, para('Three')]),
        ).toEqual(['One', '', 'Two', 'pageBreak', 'Three']);
    });

    test('an empty list item before a break stays: it shows its number', () => {
        expect(assembled([item('One', 0, 1), item('', 0, 2), { kind: 'break' }, item('Three', 0, 3)])).toEqual([
            'orderedList[listItem[One] | listItem[ | pageBreak] | listItem[Three]]',
        ]);
    });
});

describe('floats', () => {
    const figure: JSONContent = { type: 'figure', attrs: { mediaName: 'image-1.png', layout: 'wrap-left' } };

    test("a float anchored in a numbered heading follows the heading's number", () => {
        const heading = para('2. ', { role: { kind: 'heading', level: 1 }, labelled: true });
        heading.inlines.push({ type: 'text', text: 'Results' });
        const [block] = build([{ kind: 'float', figure }, heading]);
        expect(block?.content?.map((node) => (node.type === 'text' ? node.text : node.type))).toEqual([
            '2. ',
            'figure',
            'Results',
        ]);
    });
});
