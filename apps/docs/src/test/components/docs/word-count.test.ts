// Tools › Word count counts as Google Docs does: whitespace-separated words, characters without line breaks.
import { expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import { readLatex, writeMathml } from '@workspace/math';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { countWords } from '../../../components/docs/word-count';
import { sampleChartParts } from '../../fixtures/chart-parts';

// An equation reads its stored MathML with DOMParser.
installHappyDom();

const schema = getSchema(getDocExtensions());

const text = (t: string) => ({ type: 'text', text: t });
const paragraph = (t?: string) => ({ type: 'paragraph', content: t ? [text(t)] : [] });

function state(content: object[]) {
    return EditorState.create({ doc: schema.nodeFromJSON({ type: 'doc', content }) });
}

const counts = (content: object[]) => countWords(state(content)).document;

test('an empty doc counts nothing', () => {
    expect(counts([paragraph()])).toEqual({ words: 0, characters: 0, charactersExcludingSpaces: 0 });
});

test('a paragraph boundary splits words and adds no character', () => {
    expect(counts([paragraph('Hello world'), paragraph('again')])).toEqual({
        words: 3,
        characters: 16,
        charactersExcludingSpaces: 15,
    });
});

test('runs of spaces, tabs and hard breaks separate words without making any', () => {
    const content = [{ type: 'paragraph', content: [text('one   two\tthree'), { type: 'hardBreak' }, text('four')] }];
    expect(counts(content)).toEqual({ words: 4, characters: 19, charactersExcludingSpaces: 15 });
});

test('a hyphenated word is one word and a token of punctuation alone is none', () => {
    expect(counts([paragraph('well-known — fact, 2026!')]).words).toBe(3);
});

test('the text of every table cell counts', () => {
    const cell = (t: string) => ({ type: 'tableCell', content: [paragraph(t)] });
    const table = {
        type: 'table',
        content: [
            { type: 'tableRow', content: [cell('Name'), cell('Role')] },
            { type: 'tableRow', content: [cell('Ada'), cell('Engineer')] },
        ],
    };
    expect(counts([table])).toEqual({ words: 4, characters: 19, charactersExcludingSpaces: 19 });
});

test('the text of every list item counts', () => {
    const item = (t: string) => ({ type: 'listItem', content: [paragraph(t)] });
    const list = { type: 'bulletList', content: [item('Buy milk'), item('Call Bob')] };
    expect(counts([list])).toEqual({ words: 4, characters: 16, charactersExcludingSpaces: 14 });
});

test("a figure's caption counts, its alt text and media name do not", () => {
    const figure = { type: 'figure', attrs: { mediaName: 'chart.png', alt: 'A bar chart', caption: 'Sales by month' } };
    const content = [{ type: 'paragraph', content: [text('See'), figure, text('below')] }];
    expect(counts(content)).toEqual({ words: 5, characters: 22, charactersExcludingSpaces: 20 });
});

// As Google Docs counts a chart: an image, whose own titles and labels are no words of the doc.
test('a chart counts as an image does, by its caption alone', () => {
    const chart = { type: 'chart', attrs: { ...sampleChartParts('bar'), caption: 'Sales by month' } };
    const content = [{ type: 'paragraph', content: [text('See'), chart, text('below')] }];
    expect(counts(content)).toEqual({ words: 5, characters: 22, charactersExcludingSpaces: 20 });
});

// Its linear form, which spaces only where an operand ends: an empty equation counts nothing.
test("an equation's linear form counts as words apart from the text beside it", () => {
    const equation = (latex: string) => ({ type: 'equation', attrs: { mathml: writeMathml(readLatex(latex), latex) } });
    const content = [{ type: 'paragraph', content: [text('area'), equation('\\sin x'), equation(''), text('m')] }];
    expect(counts(content)).toEqual({ words: 4, characters: 10, charactersExcludingSpaces: 9 });
});

test('a non-Latin script counts its words and characters', () => {
    expect(counts([paragraph('Привет мир'), paragraph('Γειά σου κόσμε')])).toEqual({
        words: 5,
        characters: 24,
        charactersExcludingSpaces: 21,
    });
});

test('a character is what a reader sees as one, an emoji with a modifier included', () => {
    expect(counts([paragraph('ok 👍🏽')])).toEqual({ words: 1, characters: 4, charactersExcludingSpaces: 3 });
});

test('a caret counts no selection; a range counts itself beside the whole doc', () => {
    const doc = state([paragraph('Hello brave new world')]);
    expect(countWords(doc).selection).toBeNull();

    // "brave new" sits at 7 to 16.
    const selected = doc.apply(doc.tr.setSelection(TextSelection.create(doc.doc, 7, 16)));
    expect(countWords(selected)).toEqual({
        selection: { words: 2, characters: 9, charactersExcludingSpaces: 8 },
        document: { words: 4, characters: 21, charactersExcludingSpaces: 18 },
    });
});

// Google Docs counts no footnote, and the reference ends the word before it.
test("a footnote's note counts nothing, in the doc and a selection across its reference", () => {
    const note = { type: 'footnote', content: [paragraph('Hello world'), paragraph('again')] };
    const doc = state([{ type: 'paragraph', content: [text('Claim'), note, text('more words')] }]);
    expect(countWords(doc).document).toEqual({ words: 3, characters: 15, charactersExcludingSpaces: 14 });

    const all = doc.apply(doc.tr.setSelection(TextSelection.create(doc.doc, 1, doc.doc.content.size - 1)));
    expect(countWords(all).selection?.words).toBe(3);
});
