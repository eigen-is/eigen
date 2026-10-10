import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { QUOTE_LOOK } from '../../../lib/document/looks';
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
            pPr: {},
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

    test('a page break before an empty line at the item text stands after the list with the line', () => {
        expect(assembled([item('One', 0, 1), { kind: 'break' }, para('', { indLeft: ITEM_INDENT })])).toEqual([
            'orderedList[listItem[One]]',
            'pageBreak',
            '',
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

// Depth comes from Word's level within one list; a list of another definition nests only where its number starts at or
// right of the open item's text.
describe('lists of two definitions', () => {
    const bullet = (text: string, key: string, numberAt: number, indLeft = numberAt + 360): Para =>
        para(text, {
            indLeft,
            numberAt,
            list: {
                key,
                ordered: false,
                format: 'bullet',
                number: 1,
                label: () => '',
                suffix: 'tab',
                pPr: {},
                ilvl: 0,
            },
        });

    test('a number right of the open text nests', () => {
        expect(assembled([bullet('One', 'a', 360), bullet('Inner', 'b', 1080)])).toEqual([
            'bulletList[listItem[One | bulletList[listItem[Inner]]]]',
        ]);
    });

    test('a number left of the open text is a sibling list, however far its text is indented', () => {
        expect(assembled([bullet('One', 'a', 360), bullet('Other', 'b', 360, 1440)])).toEqual([
            'bulletList[listItem[One]]',
            'bulletList[listItem[Other]]',
        ]);
    });

    test('an empty paragraph between items of two lists stands between them', () => {
        expect(assembled([bullet('One', 'a', 360), para(''), bullet('Two', 'b', 360)])).toEqual([
            'bulletList[listItem[One]]',
            '',
            'bulletList[listItem[Two]]',
        ]);
    });

    test('an empty paragraph before a paragraph at the open text stays in the item, and the list goes on', () => {
        const text = para('More', { indLeft: 720 });
        expect(assembled([bullet('One', 'a', 360), para(''), text, bullet('Two', 'a', 360)])).toEqual([
            'bulletList[listItem[One |  | More] | listItem[Two]]',
        ]);
    });

    test('an empty paragraph after a nested list, before the next item of the outer one, keeps the outer list one', () => {
        const nested = bullet('Inner', 'b', 1080);
        expect(assembled([bullet('One', 'a', 360), nested, para(''), bullet('Two', 'a', 360)])).toEqual([
            'bulletList[listItem[One | bulletList[listItem[Inner | ]]] | listItem[Two]]',
        ]);
    });

    test('an empty paragraph between items of one list stays in the item above', () => {
        expect(assembled([bullet('One', 'a', 360), para(''), bullet('Two', 'a', 360)])).toEqual([
            'bulletList[listItem[One | ] | listItem[Two]]',
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

    test("a quoted task whose checkbox sits at the margin is another editor's, and stays in its quote", () => {
        const task = para('Task', { indLeft: ITEM_INDENT, numberAt: 0, quote: 1, task: { checked: false } });
        expect(assembled([task])).toEqual(['blockquote[taskList[taskItem[Task]]]']);
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

    // G10: the writer clears an item's wrapped figure with a break; a Google Docs re-save drops its clear and its style.
    test("the line break clearing an item's wrapped figure stays out of the list", () => {
        const holder = item('', 0, 1);
        const cleared = para('', { inlines: [{ type: 'hardBreak' }], empty: false });
        expect(
            assembled([
                { kind: 'float', figure },
                holder,
                para('One', { indLeft: ITEM_INDENT }),
                cleared,
                item('Two', 0, 2),
            ]),
        ).toEqual(['orderedList[listItem[figure | One] | listItem[Two]]']);
    });

    test('a line break between items without a wrapped figure ends the list', () => {
        const broken = para('', { inlines: [{ type: 'hardBreak' }], empty: false });
        expect(assembled([item('One', 0, 1), broken, item('Two', 0, 2)])).toEqual([
            'orderedList[listItem[One]]',
            'hardBreak',
            'orderedList[listItem[Two]]',
        ]);
    });

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
