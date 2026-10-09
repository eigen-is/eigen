import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { importDocxBody, marksOfType, nodesOfType } from '../../fixtures/golden-docx';

// A paragraph's rules: blank lines, breaks, alignment, comments.

const run = (text: string, rPr = '') =>
    `<w:r>${rPr && `<w:rPr>${rPr}</w:rPr>`}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (inner: string, pPr = '') => `<w:p>${pPr && `<w:pPr>${pPr}</w:pPr>`}${inner}</w:p>`;
const EMPTY = '<w:p/>';
const PAGE_BREAK = '<w:r><w:br w:type="page"/></w:r>';
const section = (type?: string) => `<w:sectPr>${type ? `<w:type w:val="${type}"/>` : ''}</w:sectPr>`;

// Each top-level block as its text, a page break as 'pageBreak'.
async function blocks(body: string): Promise<string[]> {
    const { json } = await importDocxBody(body);
    return (json.content ?? []).map((node) =>
        node.type === 'pageBreak'
            ? 'pageBreak'
            : nodesOfType(node, 'text')
                  .map((text) => text.text)
                  .join(''),
    );
}

async function aligns(body: string): Promise<unknown[]> {
    const { json } = await importDocxBody(body);
    return (json.content ?? []).map((node: JSONContent) => node.attrs?.['textAlign']);
}

describe('empty paragraphs', () => {
    test('three empty paragraphs between text stay three blank lines', async () => {
        expect(await blocks(`${paragraph(run('One'))}${EMPTY.repeat(3)}${paragraph(run('Two'))}`)).toEqual([
            'One',
            '',
            '',
            '',
            'Two',
        ]);
    });

    // A run that ends where a page does would draw a blank page: Eigen's empty line is taller than Word's.
    test.each([
        ['a page break', paragraph(PAGE_BREAK)],
        ['a paragraph that starts a page', paragraph(run('Two'), '<w:pageBreakBefore/>')],
    ])('a run of them before %s goes', async (_where, next) => {
        const result = await blocks(`${paragraph(run('One'))}${EMPTY.repeat(3)}${next}${paragraph(run('Two'))}`);
        expect(result.slice(0, 2)).toEqual(['One', 'pageBreak']);
    });

    // A section break sits on the section's last paragraph; nextPage is the default, and the body's own sectPr is none.
    test.each([
        ['nextPage', 'nextPage', ['One', 'pageBreak', 'Two']],
        ['a missing type', undefined, ['One', 'pageBreak', 'Two']],
        ['oddPage', 'oddPage', ['One', 'pageBreak', 'Two']],
        ['continuous', 'continuous', ['One', '', '', '', 'Two']],
        ['nextColumn', 'nextColumn', ['One', '', '', '', 'Two']],
    ])('before a section break of %s', async (_name, type, expected) => {
        const body = `${paragraph(run('One'))}${EMPTY.repeat(2)}${paragraph('', section(type))}${paragraph(run('Two'))}${section()}`;
        expect(await blocks(body)).toEqual(expected);
    });

    test('a paragraph of spaces counts as empty before a break', async () => {
        expect(
            await blocks(
                `${paragraph(run('One'))}${paragraph(run('   '))}${paragraph(PAGE_BREAK)}${paragraph(run('Two'))}`,
            ),
        ).toEqual(['One', 'pageBreak', 'Two']);
    });
});

describe('alignment', () => {
    // Google Docs writes left on every paragraph; it is the default, so no attribute.
    test.each([
        ['left', '', null],
        ['start', '', null],
        ['end', '', 'right'],
        ['right', '', 'right'],
        ['center', '', 'center'],
        ['both', '', 'justify'],
        ['start', '<w:bidi/>', 'right'],
        ['end', '<w:bidi/>', null],
    ])('w:jc %s%s is %s', async (jc, bidi, expected) => {
        expect(await aligns(paragraph(run('Text'), `${bidi}<w:jc w:val="${jc}"/>`))).toEqual([expected]);
    });
});

describe('comments', () => {
    test('a commented range keeps its text and gains no mark', async () => {
        const { json } = await importDocxBody(
            paragraph(
                `${run('Before ')}<w:commentRangeStart w:id="0"/>${run('commented')}<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>${run(' after')}`,
            ),
        );
        expect(nodesOfType(json, 'text').map((node) => node.text)).toEqual(['Before commented after']);
        expect(marksOfType(json, 'comment')).toEqual([]);
    });
});

describe('tracked changes and hidden text', () => {
    test('an insertion counts, a deletion and hidden text do not', async () => {
        const body = paragraph(
            `${run('Kept ')}<w:ins w:id="1" w:author="A">${run('inserted ')}</w:ins><w:del w:id="2" w:author="A"><w:r><w:delText>deleted </w:delText></w:r></w:del>${run('hidden ', '<w:vanish/>')}${run('end')}`,
        );
        expect(await blocks(body)).toEqual(['Kept inserted end']);
    });

    // Accepted, a deleted paragraph mark leaves the following paragraph's mark, and so its properties, to both.
    test('a paragraph whose mark is deleted joins the next, which keeps its properties and its number', async () => {
        const numbering =
            '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>';
        const deleted = '<w:rPr><w:del w:id="1" w:author="A"/></w:rPr>';
        const numbered = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>';
        const { json } = await importDocxBody(
            `${paragraph(run('Joined '), deleted)}${paragraph(run('centred'), '<w:jc w:val="center"/>')}${paragraph(run('One '), `${numbered}${deleted}`)}${paragraph(run('and more'), numbered)}${paragraph(run('Two'), numbered)}`,
            { numbering },
        );
        expect(json.content).toEqual([
            { type: 'paragraph', attrs: { textAlign: 'center' }, content: [{ type: 'text', text: 'Joined centred' }] },
            {
                type: 'orderedList',
                attrs: { start: 1, type: null },
                content: ['One and more', 'Two'].map((text) => ({
                    type: 'listItem',
                    content: [{ type: 'paragraph', attrs: { textAlign: null }, content: [{ type: 'text', text }] }],
                })),
            },
        ]);
    });

    test("text joined into the body's last, empty paragraph after a table stays", async () => {
        const table = `<w:tbl><w:tr><w:tc>${paragraph(run('Cell'))}</w:tc></w:tr></w:tbl>`;
        const deleted = '<w:rPr><w:del w:id="1" w:author="A"/></w:rPr>';
        expect(await blocks(`${table}${paragraph(run('Last'), deleted)}${EMPTY}`)).toEqual(['Cell', 'Last']);
    });
});

// Other editors indent code as they indent text: only the writer's own indents nest it in quotes.
describe('indented code', () => {
    const PRE =
        '<w:style w:type="paragraph" w:styleId="HTMLPreformatted"><w:name w:val="HTML Preformatted"/></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/></w:style>';
    const BULLETS =
        '<w:abstractNum w:abstractNumId="5"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="5"/></w:num>';
    const pre = (text: string) => paragraph(run(text), '<w:pStyle w:val="HTMLPreformatted"/><w:ind w:left="720"/>');
    const text = (value: string) => ({
        type: 'paragraph',
        attrs: { textAlign: null },
        content: [{ type: 'text', text: value }],
    });
    const code = { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'x = 1' }] };

    test('at the margin is code at the margin', async () => {
        const { json } = await importDocxBody(`${paragraph(run('Before'))}${pre('x = 1')}${paragraph(run('After'))}`, {
            styles: PRE,
        });
        expect(json.content).toEqual([text('Before'), code, text('After')]);
    });

    test("at a bullet's text is code in the item", async () => {
        const { json } = await importDocxBody(
            `${paragraph(run('Item'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr>')}${pre('x = 1')}${paragraph(run('After'))}`,
            { styles: PRE, numbering: BULLETS },
        );
        expect(json.content).toEqual([
            { type: 'bulletList', content: [{ type: 'listItem', content: [text('Item'), code] }] },
            text('After'),
        ]);
    });

    test('right after a quote continues it', async () => {
        const { json } = await importDocxBody(
            `${paragraph(run('Said'), '<w:pStyle w:val="Quote"/>')}${pre('x = 1')}${paragraph(run('After'))}`,
            { styles: PRE },
        );
        expect(json.content).toEqual([{ type: 'blockquote', content: [text('Said'), code] }, text('After')]);
    });
});
