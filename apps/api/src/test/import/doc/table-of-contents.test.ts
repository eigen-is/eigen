import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { importDocxBody, nodesOfType } from '../../fixtures/golden-docx';

// A Word table of contents is a TOC field whose result holds Word's saved entries. The import reads it as one node,
// whose entries the doc derives from its headings again.

const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (inner: string, style?: string) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${inner}</w:p>`;
const heading = (text: string) => paragraph(run(text), 'Heading1');
const field = (code: string) =>
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${code} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>`;
const END = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';

// An entry as Word writes one: a link to the heading's bookmark, a tab, and the PAGEREF field's page.
const entry = (text: string, page: number, id: number) =>
    `<w:hyperlink w:anchor="_Toc${id}" w:history="1">${run(text)}<w:r><w:tab/></w:r>${field(`PAGEREF _Toc${id} \\h`)}${run(String(page))}${END}</w:hyperlink>`;

// Word's own: in its gallery's content control, the field begun in the first entry and ended in a paragraph of its own.
function wordToc(code: string, entries: string[], { sdt = true, title = false } = {}): string {
    const paragraphs = entries.map((text, index) =>
        paragraph(`${index === 0 ? field(code) : ''}${entry(text, index + 1, index + 1)}`, 'TOC1'),
    );
    const content = `${title ? paragraph(run('Contents'), 'TOCHeading') : ''}${paragraphs.join('')}${paragraph(END)}`;
    return sdt
        ? `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent>${content}</w:sdtContent></w:sdt>`
        : content;
}

const STYLES =
    '<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/></w:style><w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Heading1"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style>';

const read = (body: string) => importDocxBody(body, { styles: STYLES });

// Each block as its type, with a table of contents' levels and a textblock's text.
const blocks = (json: JSONContent) =>
    (json.content ?? []).map((block) =>
        block.type === 'tableOfContents'
            ? `toc ${block.attrs?.['levels']}`
            : `${block.type}: ${nodesOfType(block, 'text')
                  .map((node) => node.text)
                  .join('')}`,
    );

describe('a docx table of contents', () => {
    test("Word's, in its content control after its title, is the title's paragraph and one node", async () => {
        const { json } = await read(
            `${paragraph(run('Report'))}${wordToc('TOC \\o "1-3" \\h \\z \\u', ['Intro', 'Method'], { title: true })}${heading('Intro')}${heading('Method')}`,
        );
        expect(blocks(json)).toEqual([
            'paragraph: Report',
            'paragraph: Contents',
            'toc 3',
            'heading: Intro',
            'heading: Method',
        ]);
    });

    test('a bare field outside a content control is one node too', async () => {
        const { json } = await read(
            `${wordToc('TOC \\o "1-2" \\h \\z \\u', ['Intro'], { sdt: false })}${heading('Intro')}`,
        );
        expect(blocks(json)).toEqual(['toc 2', 'heading: Intro']);
    });

    test.each([
        ['TOC \\o "1-2" \\h \\z \\u', 2],
        ['TOC \\o "1-1" \\h \\z \\t "QES Heading 1,1"', 1],
        ['TOC \\o "1-6" \\t "Heading 0,8,Heading 7,1,Heading 9,3"', 6],
        ['TOC \\z \\o \\h', 6],
        ['TOC \\h \\z \\u', 3],
    ])('%s lists to level %p', async (code, levels) => {
        const { json } = await read(`${wordToc(code, ['Intro'])}${heading('Intro')}`);
        expect(nodesOfType(json, 'tableOfContents').map((node) => node.attrs?.['levels'])).toEqual([levels]);
    });

    test('a table of figures stays its paragraphs', async () => {
        const { json } = await read(wordToc('TOC \\h \\z \\c "Figure"', ['Figure 1: A chart']));
        expect(nodesOfType(json, 'tableOfContents')).toEqual([]);
        expect(blocks(json)).toEqual(['paragraph: Figure 1: A chart\t1', 'paragraph: ']);
    });

    // Word's saved entries and their page numbers, its links and its PAGEREF fields, are the result: none of it stays.
    test('text before the field begins and after it ends stays, and none of the result leaks', async () => {
        const body = [
            paragraph(`${run('Before ')}${field('TOC \\o "1-3" \\h')}${entry('Intro', 3, 1)}`),
            paragraph(`${entry('Method', 4, 2)}${END}${run('After')}`),
            heading('Intro'),
        ].join('');
        const { json } = await read(body);
        expect(blocks(json)).toEqual(['paragraph: Before ', 'toc 3', 'paragraph: After', 'heading: Intro']);
    });

    test('in a table cell it stays its paragraphs, as only the body holds the node', async () => {
        const cell = `<w:tbl><w:tblGrid><w:gridCol w:w="5000"/></w:tblGrid><w:tr><w:tc>${wordToc('TOC \\o "1-3" \\h', ['Intro'], { sdt: false })}</w:tc></w:tr></w:tbl>`;
        const { json } = await read(`${cell}${heading('Intro')}`);
        expect(nodesOfType(json, 'tableOfContents')).toEqual([]);
        expect(nodesOfType(json, 'text').map((node) => node.text)).toContain('Intro\t1');
    });

    // A field that never ends would take the rest of the doc with it.
    test('a field the file never ends keeps the text after it', async () => {
        const body = `${paragraph(`${field('TOC \\o "1-3" \\h')}${entry('Intro', 1, 1)}`)}${heading('Intro')}${paragraph(run('Body'))}`;
        const { json } = await read(body);
        expect(nodesOfType(json, 'text').map((node) => node.text)).toEqual(expect.arrayContaining(['Intro', 'Body']));
    });

    test("warns when the doc's headings differ from the entries Word saved, and not when they match", async () => {
        const matching = await read(
            `${wordToc('TOC \\o "1-3" \\h', ['Intro', 'Method'])}${heading('Intro')}${heading('Method')}`,
        );
        expect(matching.warnings).toEqual([]);
        const stale = await read(
            `${wordToc('TOC \\o "1-3" \\h', ['Intro', 'Old name'])}${heading('Intro')}${heading('Method')}`,
        );
        expect(stale.warnings).toEqual([{ code: 'toc-entries-changed', count: 1 }]);
    });
});
