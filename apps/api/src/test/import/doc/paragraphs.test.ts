import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { CODE_BLOCK_LOOK } from '../../../lib/export/doc/ooxml';
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

    test("text joined into a numbered heading follows the heading's number", async () => {
        const numbering =
            '<w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="7"/></w:num>';
        const { json } = await importDocxBody(
            `${paragraph(run('Joined '), '<w:rPr><w:del w:id="1" w:author="A"/></w:rPr>')}${paragraph(run('Title'), '<w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr>')}`,
            { numbering },
        );
        expect(json.content).toEqual([
            {
                type: 'heading',
                attrs: { level: 1, textAlign: null },
                content: [{ type: 'text', text: '1. Joined Title' }],
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

    // A page break keeps a quote open; only a table or a rule ends it.
    const said = paragraph(run('Said'), '<w:pStyle w:val="Quote"/>');
    const codeOf = (value: string) => ({
        type: 'codeBlock',
        attrs: { language: null },
        content: [{ type: 'text', text: value }],
    });
    const pageBreak = { type: 'pageBreak' };
    test.each([
        [
            'in the code',
            `${said}${pre(`a</w:t></w:r>${PAGE_BREAK}<w:r><w:t>b`)}`,
            [codeOf('a'), pageBreak, codeOf('b')],
        ],
        ['of its own', `${said}${paragraph(PAGE_BREAK)}${pre('x = 1')}`, [pageBreak, code]],
        [
            'before the code',
            `${said}${paragraph(run('x = 1'), '<w:pStyle w:val="HTMLPreformatted"/><w:pageBreakBefore/><w:ind w:left="720"/>')}`,
            [pageBreak, code],
        ],
        [
            'ending the quote',
            `${paragraph(`${run('Said')}${PAGE_BREAK}`, '<w:pStyle w:val="Quote"/>')}${pre('x = 1')}`,
            [pageBreak, code],
        ],
    ])('right after a quote, across a page break %s, continues it', async (_where, body, rest) => {
        const { json } = await importDocxBody(`${body}${paragraph(run('After'))}`, { styles: PRE });
        expect(json.content).toEqual([{ type: 'blockquote', content: [text('Said'), ...rest] }, text('After')]);
    });

    test.each([
        ['table', `<w:tbl><w:tr><w:tc>${paragraph(run('Cell'))}</w:tc></w:tr></w:tbl>`, 'table'],
        ['rule', paragraph('', '<w:pBdr><w:bottom w:val="single" w:sz="6"/></w:pBdr>'), 'horizontalRule'],
    ])('after a quote and a %s is code at the margin', async (_name, between, type) => {
        const { json } = await importDocxBody(`${said}${between}${pre('x = 1')}`, { styles: PRE });
        expect(json.content?.map((node) => node.type)).toEqual(['blockquote', type, 'codeBlock']);
    });

    // 567 is 1 cm, 2160 Google Docs' 1.5": each within INDENT_TOLERANCE of the writer's code box in whole quotes.
    const atIndent = (style: string, indent: number) =>
        paragraph(run('x = 1'), `<w:pStyle w:val="${style}"/><w:ind w:left="${indent}"/>`);
    const quoted = (depth: number): JSONContent =>
        depth === 0 ? code : { type: 'blockquote', content: [quoted(depth - 1)] };

    test.each([567, 1134, 2160])("at %i twips in another editor's style is code at the margin", async (indent) => {
        const { json } = await importDocxBody(atIndent('HTMLPreformatted', indent), { styles: PRE });
        expect(json.content).toEqual([code]);
    });

    test.each([
        [567, 1],
        [1134, 3],
        [2160, 7],
    ])("at %i twips in the writer's style is code %i quotes deep", async (indent, depth) => {
        const styles = '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/></w:style>';
        const { json } = await importDocxBody(atIndent('CodeBlock', indent), { styles });
        expect(json.content).toEqual([quoted(depth)]);
    });

    test("in the writer's style for a language, which a re-save may rename, nests too", async () => {
        const styles = '<w:style w:type="paragraph" w:styleId="Python"><w:name w:val="Code Block (python)"/></w:style>';
        const { json } = await importDocxBody(atIndent('Python', 1134), { styles });
        expect(nodesOfType(json, 'blockquote')).toHaveLength(3);
        expect(nodesOfType(json, 'codeBlock')[0]?.attrs).toEqual({ language: 'python' });
    });

    const { fill } = CODE_BLOCK_LOOK;
    const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="11" w:color="${fill}"/>`;
    test.each([
        [
            "the code box's fill and borders, as a Google Docs re-save keeps them,",
            3,
            ['top', 'left', 'bottom', 'right'],
        ],
        ["the code box's fill alone", 0, []],
    ])('in %s at 1134 twips is code %i quotes deep', async (_look, depth, sides) => {
        const box = `<w:pBdr>${sides.map(border).join('')}</w:pBdr><w:shd w:val="clear" w:fill="${fill}"/><w:ind w:left="1134"/>`;
        const { json } = await importDocxBody(
            paragraph(run('x = 1', '<w:rFonts w:ascii="JetBrains Mono" w:hAnsi="JetBrains Mono"/>'), box),
        );
        expect(json.content).toEqual([quoted(depth)]);
    });
});
