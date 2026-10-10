import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { CODE_BLOCK_LOOK, QUOTE_LOOK } from '../../../lib/document/looks';
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

    // P2: a heading line would draw taller than the blank line Word shows.
    test('an empty heading holding a bookmark is a blank line', async () => {
        const heading = paragraph(
            '<w:bookmarkStart w:id="0" w:name="_Top"/><w:bookmarkEnd w:id="0"/>',
            '<w:pStyle w:val="Heading1"/>',
        );
        const { json } = await importDocxBody(`${paragraph(run('One'))}${heading}${paragraph(run('Two'))}`);
        expect(json.content?.[1]).toEqual({ type: 'paragraph', attrs: { textAlign: null } });
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

// Google Docs writes a checklist item as its glyph, then a tab or a space or two, then the text.
describe('a checkbox glyph opening a paragraph', () => {
    async function read(text: string): Promise<[string | undefined, boolean | undefined, string]> {
        const { json } = await importDocxBody(paragraph(run(text)));
        const [block] = json.content ?? [];
        const checked = block?.content?.[0]?.attrs?.['checked'];
        return [
            block?.type,
            checked,
            nodesOfType(block ?? {}, 'text')
                .map((node) => node.text)
                .join(''),
        ];
    }

    test.each([
        ['a tab', '☐\tMilk', false],
        ['a space', '☒ Milk', true],
        ['two spaces', '☐  Milk', false],
    ])('followed by %s opens a task item', async (_after, text, checked) => {
        expect(await read(text)).toEqual(['taskList', checked, 'Milk']);
    });

    test.each(['☐2 apples', '☐{x}', '☐}'])('followed by anything else is text: %s', async (text) => {
        expect(await read(text)).toEqual(['paragraph', undefined, text]);
    });
});

// The task item's checkbox stands where Word's box and the space after it stood.
describe('a checkbox opening a task', () => {
    const W14 = 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
    const control = `<w:sdt><w:sdtPr><w14:checkbox ${W14}><w14:checked ${W14} w14:val="1"/></w14:checkbox></w:sdtPr><w:sdtContent>${run('☒')}</w:sdtContent></w:sdt>`;
    const formField = `<w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:checkBox><w:default w:val="0"/></w:checkBox></w:ffData></w:fldChar></w:r><w:r><w:instrText xml:space="preserve"> FORMCHECKBOX </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;

    test('drops the spaces and tabs after a content control, a form field or a glyph, across runs', async () => {
        const { json } = await importDocxBody(
            `${paragraph(`${run(' ')}${control}${run('  &lt;3 months ago')}`)}${paragraph(`${formField}<w:r><w:tab/></w:r>${run('  No diploma')}`)}${paragraph(`${run('☐ ')}${run('   Milk')}`)}`,
        );
        expect(
            nodesOfType(json, 'taskItem').map((item) => [
                item.attrs?.['checked'],
                nodesOfType(item, 'text')
                    .map((node) => node.text)
                    .join(''),
            ]),
        ).toEqual([
            [true, '<3 months ago'],
            [false, 'No diploma'],
            [false, 'Milk'],
        ]);
    });
});

// Word sets a note's text off its number with a space or a tab; Eigen's list numbers the note.
describe('notes', () => {
    test("a note's text starts at its first character", async () => {
        const note = (id: number, inner: string) =>
            `<w:footnote w:id="${id}">${paragraph(`<w:r><w:footnoteRef/></w:r>${inner}`)}</w:footnote>`;
        const { json } = await importDocxBody(
            paragraph(
                `${run('Text')}<w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:footnoteReference w:id="2"/></w:r>`,
            ),
            { footnotes: `${note(1, run(' Note text'))}${note(2, `<w:r><w:tab/></w:r>${run(' Other')}`)}` },
        );
        const notes = json.content?.at(-1);
        expect(
            (notes?.content ?? []).map((item) =>
                nodesOfType(item, 'text')
                    .map((node) => node.text)
                    .join(''),
            ),
        ).toEqual(['Note text ↑', 'Other ↑']);
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
// G8: a code style or the writer's flattened look is code only where every run holding text is monospace.
describe('code blocks', () => {
    const font = (name: string) => `<w:rFonts w:ascii="${name}" w:hAnsi="${name}"/>`;
    const PRE =
        '<w:style w:type="paragraph" w:styleId="HTMLPreformatted"><w:name w:val="HTML Preformatted"/><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr></w:style>';
    const shaded = (fill: string) => `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`;
    const types = async (body: string) =>
        ((await importDocxBody(body, { styles: PRE })).json.content ?? []).map((node) => node.type);

    test('a Courier New paragraph without a fill is a paragraph in JetBrains Mono', async () => {
        const { json } = await importDocxBody(paragraph(run('x = 1', font('Courier New'))));
        expect(json.content?.map((node) => node.type)).toEqual(['paragraph']);
        expect(marksOfType(json, 'textStyle').map((mark) => mark.attrs['fontFamily'])).toEqual(['JetBrains Mono']);
    });

    test.each([
        ['in Times New Roman is a paragraph', run('x = 1', font('Times New Roman')), ['paragraph']],
        [
            'with a space in Times New Roman is code',
            `${run('x')}${run(' ', font('Times New Roman'))}${run('= 1')}`,
            ['codeBlock'],
        ],
    ])('HTML Preformatted %s', async (_name, runs, expected) => {
        expect(await types(paragraph(runs, '<w:pStyle w:val="HTMLPreformatted"/>'))).toEqual(expected);
    });

    // An empty line draws in its mark's face, which tells a blank line of code from a blank line in prose.
    test.each([
        ['Times New Roman', ['paragraph', 'paragraph', 'paragraph']],
        ['Courier New', ['codeBlock']],
    ])('an empty HTML Preformatted line marked in %s', async (face, expected) => {
        const line = (text: string) => paragraph(run(text, font(face)), '<w:pStyle w:val="HTMLPreformatted"/>');
        const empty = paragraph('', `<w:pStyle w:val="HTMLPreformatted"/><w:rPr>${font(face)}</w:rPr>`);
        expect(await types(`${line('a')}${empty}${line('b')}`)).toEqual(expected);
    });

    test.each([
        ['F3F4F6', ['codeBlock']],
        ['EEEEEE', ['codeBlock']],
        ['D0D0D0', ['codeBlock']],
        ['CFCFCF', ['paragraph']],
        ['DDEEFF', ['paragraph']],
    ])('monospace runs on %s', async (fill, expected) => {
        expect(await types(paragraph(run('x = 1', font('Consolas')), shaded(fill)))).toEqual(expected);
    });
});

describe('indented code', () => {
    // Word's HTML Preformatted draws in Courier New.
    const MONO = '<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr>';
    const PRE = `<w:style w:type="paragraph" w:styleId="HTMLPreformatted"><w:name w:val="HTML Preformatted"/>${MONO}</w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/></w:style>`;
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

    // Strict OOXML gives lengths in universal measures: 36pt is 720 twips, half an inch.
    test.each([
        [
            "at a bullet's text",
            '36pt',
            '0.5in',
            [{ type: 'bulletList', content: [{ type: 'listItem', content: [text('Item'), code] }] }],
        ],
        [
            "left of a bullet's text",
            '1in',
            '36pt',
            [{ type: 'bulletList', content: [{ type: 'listItem', content: [text('Item')] }] }, code],
        ],
    ])('in points %s', async (_name, bullet, indent, expected) => {
        const numbering = BULLETS.replace('w:left="720" w:hanging="360"', `w:start="${bullet}" w:hanging="18pt"`);
        const { json } = await importDocxBody(
            `${paragraph(run('Item'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr>')}${paragraph(run('x = 1'), `<w:pStyle w:val="HTMLPreformatted"/><w:ind w:left="${indent}"/>`)}`,
            { styles: PRE, numbering },
        );
        expect(json.content).toEqual(expected);
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

    // An indent comes from the style unless the list level or the paragraph sets one.
    const INDENTED = `${PRE}<w:style w:type="paragraph" w:styleId="Indented"><w:name w:val="Indented"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="IndentedPre"><w:name w:val="HTML Preformatted"/><w:pPr><w:ind w:left="720"/></w:pPr>${MONO}</w:style>`;
    const UNINDENTED =
        '<w:abstractNum w:abstractNumId="6"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="6"><w:abstractNumId w:val="6"/></w:num>';
    const styledPre = paragraph(run('x = 1'), '<w:pStyle w:val="IndentedPre"/>');
    const item = (pPr: string) =>
        paragraph(run('Item'), `${pPr}<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${pPr ? 6 : 5}"/></w:numPr>`);
    const inItem = [{ type: 'bulletList', content: [{ type: 'listItem', content: [text('Item'), code] }] }];
    test.each([
        [
            'right after a quote continues it',
            `${said}${styledPre}`,
            [{ type: 'blockquote', content: [text('Said'), code] }],
        ],
        ["at a bullet's text is code in the item", `${item('')}${styledPre}`, inItem],
        [
            'at the text of a bullet in it whose level sets none is code in the item',
            `${item('<w:pStyle w:val="Indented"/>')}${pre('x = 1')}`,
            inItem,
        ],
    ])('indented by its style, %s', async (_name, body, expected) => {
        const { json } = await importDocxBody(body, { styles: INDENTED, numbering: `${BULLETS}${UNINDENTED}` });
        expect(json.content).toEqual(expected);
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
        const styles = `<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/>${MONO}</w:style>`;
        const { json } = await importDocxBody(atIndent('CodeBlock', indent), { styles });
        expect(json.content).toEqual([quoted(depth)]);
    });

    test("in the writer's style for a language, which a re-save may rename, nests too", async () => {
        const styles = `<w:style w:type="paragraph" w:styleId="Python"><w:name w:val="Code Block (python)"/>${MONO}</w:style>`;
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

// A list of another definition nests under the open item only where its level puts its number at or right of the
// item's text: the spec's two numIds at ilvl 0 under a 720 text.
describe('lists of two definitions', () => {
    const level = (id: number, left: number) =>
        `<w:abstractNum w:abstractNumId="${id}"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>`;
    const NUMBERING = `${level(1, 720)}${level(2, 1440)}${level(3, 720)}<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num><w:num w:numId="3"><w:abstractNumId w:val="3"/></w:num>`;
    const bullet = (numId: number, text: string) =>
        paragraph(run(text), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`);
    const types = async (body: string) =>
        ((await importDocxBody(body, { numbering: NUMBERING })).json.content ?? []).map(
            (node) => nodesOfType(node, 'bulletList').length,
        );

    test('a number at 1,080 under a 720 text nests', async () => {
        expect(await types(`${bullet(1, 'One')}${bullet(2, 'Inner')}`)).toEqual([2]);
    });

    test('numbers both at 360 are sibling lists', async () => {
        expect(await types(`${bullet(1, 'One')}${bullet(3, 'Other')}`)).toEqual([1, 1]);
    });
});

// Word reads each w:ind attribute on its own along the style chain, and starts a hanging first line left of the text.
describe('indents', () => {
    const STYLES = [
        '<w:style w:type="paragraph" w:styleId="Indented"><w:name w:val="Indented"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>',
        '<w:style w:type="paragraph" w:styleId="Child"><w:name w:val="Child"/><w:basedOn w:val="Indented"/><w:pPr><w:ind w:firstLine="0"/></w:pPr></w:style>',
        '<w:style w:type="paragraph" w:styleId="Hanging"><w:name w:val="Hanging"/><w:pPr><w:ind w:left="1021" w:hanging="1021"/></w:pPr></w:style>',
        `<w:style w:type="paragraph" w:styleId="Requirement"><w:name w:val="Requirement"/><w:pPr><w:pBdr><w:left w:val="single" w:sz="${QUOTE_LOOK.border.sz}" w:space="8" w:color="${QUOTE_LOOK.border.color}"/></w:pBdr><w:ind w:left="1134" w:hanging="1134"/></w:pPr></w:style>`,
    ].join('');
    const NUMBERING =
        '<w:abstractNum w:abstractNumId="5"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="5"/></w:num>';
    const bullet = paragraph(run('Item'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr>');
    const outline = async (body: string) =>
        ((await importDocxBody(body, { styles: STYLES, numbering: NUMBERING })).json.content ?? []).map((node) =>
            node.type === 'bulletList'
                ? `bulletList[${(node.content?.[0]?.content ?? []).map((child) => nodesOfType(child, 'text')[0]?.text).join(' | ')}]`
                : (node.type ?? ''),
        );

    test.each([
        [
            "a direct first line keeps the style's left",
            paragraph(run('Under'), '<w:pStyle w:val="Indented"/><w:ind w:firstLine="0"/>'),
        ],
        [
            "a style's first line keeps the left of the style it is based on",
            paragraph(run('Under'), '<w:pStyle w:val="Child"/>'),
        ],
    ])('%s, so the paragraph continues the item', async (_name, under) => {
        expect(await outline(`${bullet}${under}`)).toEqual(['bulletList[Item | Under]']);
    });

    test("a paragraph hanging from the item's text back to the margin starts at the margin, after the list", async () => {
        const centred = paragraph(run('Centred'), '<w:pStyle w:val="Hanging"/><w:jc w:val="center"/>');
        expect(await outline(`${bullet}${centred}`)).toEqual(['bulletList[Item]', 'paragraph']);
    });

    test('a left bar on a paragraph hanging back to the margin is one quote, at its first line', async () => {
        const { json } = await importDocxBody(paragraph(run('Shall'), '<w:pStyle w:val="Requirement"/>'), {
            styles: STYLES,
        });
        expect(nodesOfType(json, 'blockquote')).toHaveLength(1);
    });
});

// G7: a bar alone is a quote only at the writer's width; on a heading of another it is no quote.
describe('a left bar', () => {
    const bar = (sz: number, color: string) =>
        `<w:pBdr><w:left w:val="single" w:sz="${sz}" w:space="${QUOTE_LOOK.border.space}" w:color="${color}"/></w:pBdr><w:ind w:left="${QUOTE_LOOK.indent}"/>`;
    const writers = bar(QUOTE_LOOK.border.sz, QUOTE_LOOK.border.color);
    const types = async (body: string) =>
        (
            (
                await importDocxBody(body, {
                    styles: '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>',
                })
            ).json.content ?? []
        ).map((node) => node.type);

    test.each([
        ["the writer's on a paragraph is a quote", paragraph(run('Said'), writers), ['blockquote']],
        ['of another width is a paragraph', paragraph(run('Said'), bar(6, QUOTE_LOOK.border.color)), ['paragraph']],
        [
            "of the writer's width in another color is a quote",
            paragraph(run('Said'), bar(QUOTE_LOOK.border.sz, '2B6CB0')),
            ['blockquote'],
        ],
        [
            'on a Heading 2 leaves it a heading',
            paragraph(run('Title'), `<w:pStyle w:val="Heading2"/>${bar(12, '4472C4')}`),
            ['heading'],
        ],
    ])('%s', async (_name, body, expected) => {
        expect(await types(body)).toEqual(expected);
    });
});

describe("a node's look", () => {
    // Google Docs writes a quote's color on its runs; the color goes, what else the run's textStyle holds stays.
    test("a quote's color goes from a run in caps, its caps stay", async () => {
        const { json } = await importDocxBody(
            paragraph(run('Said', `<w:caps/><w:color w:val="${QUOTE_LOOK.color}"/>`), '<w:pStyle w:val="Quote"/>'),
            { styles: '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/></w:style>' },
        );
        expect(nodesOfType(json, 'blockquote')).toHaveLength(1);
        expect(marksOfType(json, 'textStyle').map((mark) => mark.attrs)).toEqual([
            { color: null, fontFamily: null, caps: 'all' },
        ]);
    });
});
