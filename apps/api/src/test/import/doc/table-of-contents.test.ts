import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { cpuClock } from '../../cpu-time';
import { importDocxBody, nodesOfType } from '../../fixtures/golden-docx';

// A Word table of contents is a TOC field whose result holds Word's saved entries. The import reads it as one node,
// whose entries the doc derives from its headings again.

const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (inner: string, style?: string, pPr = '') =>
    `<w:p>${style || pPr ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${pPr}</w:pPr>` : ''}${inner}</w:p>`;
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

const table = (text: string) =>
    `<w:tbl><w:tblGrid><w:gridCol w:w="5000"/></w:tblGrid><w:tr><w:tc>${paragraph(run(text))}</w:tc></w:tr></w:tbl>`;

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

    test('a paragraph that ends one and begins another cuts both results', async () => {
        const { json } = await read(
            [
                paragraph(`${field('TOC \\o "1-3"')}${run('A\t1')}`),
                paragraph(`${run('B\t2')}${END}${field('TOC \\o "1-2"')}${run('C\t3')}`),
                paragraph(END),
            ].join(''),
        );
        expect(blocks(json)).toEqual(['toc 3', 'toc 2']);
    });

    test('a section break in the paragraph that ends the field stays', async () => {
        const sectionEnd = paragraph(END, undefined, '<w:sectPr><w:type w:val="nextPage"/></w:sectPr>');
        const { json } = await read(
            `${paragraph(`${field('TOC \\o "1-3"')}${run('Intro\t1')}`)}${sectionEnd}${heading('Intro')}`,
        );
        expect(blocks(json)).toEqual(['toc 3', 'pageBreak: ', 'heading: Intro']);
    });

    test('a section break in the paragraph that begins the field follows the node', async () => {
        const sectPr = '<w:sectPr><w:type w:val="nextPage"/></w:sectPr>';
        const begins = paragraph(`${run('Before ')}${field('TOC \\o "1-3"')}${run('Intro\t1')}`, undefined, sectPr);
        const { json } = await read(`${begins}${paragraph(END)}${heading('Intro')}`);
        expect(blocks(json)).toEqual(['paragraph: Before ', 'toc 3', 'pageBreak: ', 'heading: Intro']);
    });

    // A text box is no entry: it stays a text box, in a paragraph of its own after the table of contents.
    test("a text box an entry anchors stays, and its paragraphs aren't the result's", async () => {
        const box = `<w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="2" name="Box"/><a:graphic><a:graphicData><wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:txbx><w:txbxContent>${paragraph(run('Boxed'))}</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
        const body = [
            paragraph(`${field('TOC \\o "1-3" \\h')}${entry('Intro', 1, 1)}`),
            paragraph(`${entry('Method', 2, 2)}${box}`),
            paragraph(END),
            heading('Intro'),
            heading('Method'),
        ].join('');
        const { json } = await read(body);
        expect(blocks(json)).toEqual(['toc 3', 'paragraph: Boxed', 'heading: Intro', 'heading: Method']);
        expect(json.content?.[1]?.content?.map((node) => node.type)).toEqual(['textBox']);
    });
});

// A file says where a field's result ends, and a crafted or broken one may say it late or never. A table of contents'
// result holds neither a heading nor a table, so the first of either ends the cut: what the field held stays its
// paragraphs, in place.
describe("a docx table of contents' result that runs on", () => {
    const opener = paragraph(`${field('TOC \\o "1-3" \\h')}${run('Intro\t1')}`);

    test('ended past a heading, it takes none of the body', async () => {
        const { json, warnings } = await read(
            `${opener}${heading('Real body text')}${paragraph(run('More body'))}${paragraph(END)}`,
        );
        expect(blocks(json)).toEqual([
            'paragraph: Intro\t1',
            'heading: Real body text',
            'paragraph: More body',
            'paragraph: ',
        ]);
        expect(warnings).toEqual([{ code: 'blocks-flattened', count: 1 }]);
    });

    test('ended at the start of a heading, it is a node and the heading stays', async () => {
        const { json, warnings } = await read(`${opener}${paragraph(`${END}${run('Intro')}`, 'Heading1')}`);
        expect(blocks(json)).toEqual(['toc 3', 'heading: Intro']);
        expect(warnings).toEqual([]);
    });

    test("ended after a heading's text, it takes none of the heading", async () => {
        const { json, warnings } = await read(`${opener}${paragraph(`${run('Intro')}${END}`, 'Heading1')}`);
        expect(blocks(json)).toEqual(['paragraph: Intro\t1', 'heading: Intro']);
        expect(warnings).toEqual([{ code: 'blocks-flattened', count: 1 }]);
    });

    test('begun after text in a paragraph that ends a section, its held entry comes back before the break', async () => {
        const sectPr = '<w:sectPr><w:type w:val="nextPage"/></w:sectPr>';
        const begins = paragraph(`${run('Before ')}${field('TOC \\o "1-3"')}${run('Intro\t1')}`, undefined, sectPr);
        const { json } = await read(`${begins}${heading('Intro')}`);
        expect(blocks(json)).toEqual(['paragraph: Before ', 'paragraph: Intro\t1', 'pageBreak: ', 'heading: Intro']);
    });

    test('a table of contents after the one it gave back is a node', async () => {
        const toc = paragraph(`${field('TOC \\o "1-2"')}${run('Intro\t1')}${END}`);
        const { json } = await read(`${opener}${heading('Intro')}${toc}`);
        expect(blocks(json)).toEqual(['paragraph: Intro\t1', 'heading: Intro', 'toc 2']);
    });

    test('never ended, it keeps a table after it whole and the paragraphs in their order', async () => {
        const { json } = await read(`${opener}${paragraph(run('P1'))}${table('Cell')}${paragraph(run('P2'))}`);
        expect(blocks(json)).toEqual(['paragraph: Intro\t1', 'paragraph: P1', 'table: Cell', 'paragraph: P2']);
    });

    test("never ended, it keeps a SmartArt's text, whose parts are read once", async () => {
        const DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
        const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
        const point = (id: number, text: string) =>
            `<dgm:pt modelId="${id}"><dgm:t><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></dgm:t></dgm:pt>`;
        const data = `<dgm:dataModel xmlns:dgm="${DGM}" xmlns:a="${A}"><dgm:ptLst><dgm:pt modelId="0" type="doc"/>${point(1, 'Plan')}${point(2, 'Do')}</dgm:ptLst></dgm:dataModel>`;
        const smartArt = `<w:r><w:drawing><wp:inline><wp:extent cx="2575560" cy="964504"/><wp:docPr id="3" name="Graphic 3"/><a:graphic><a:graphicData><dgm:relIds xmlns:dgm="${DGM}" r:dm="rId20"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
        const { json } = await importDocxBody(`${opener}${paragraph(smartArt)}${paragraph(run('After'))}`, {
            styles: STYLES,
            rels: '<Relationship Id="rId20" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData" Target="diagrams/data1.xml"/>',
            media: { 'word/diagrams/data1.xml': new TextEncoder().encode(data) },
        });
        expect(blocks(json).filter((block) => block !== 'paragraph: ')).toEqual([
            'paragraph: Intro\t1',
            'paragraph: Plan',
            'paragraph: Do',
            'paragraph: After',
        ]);
    });
});

// Each node draws the whole outline in the editor, so a crafted file of thousands of fields would make thousands of
// lists of thousands of entries.
describe('many docx tables of contents', () => {
    test('the first eight are nodes, and the rest stay their paragraphs, counted as flattened', async () => {
        const toc = paragraph(`${field('TOC \\o "1-3"')}${run('Intro\t1')}${END}`);
        const { json, warnings } = await read(`${toc.repeat(10)}${heading('Intro')}`);
        expect(blocks(json)).toEqual([
            ...Array.from({ length: 8 }, () => 'toc 3'),
            'paragraph: Intro\t1',
            'paragraph: Intro\t1',
            'heading: Intro',
        ]);
        expect(warnings).toEqual([{ code: 'blocks-flattened', count: 2 }]);
    });

    test('eight thousand fields beside eight thousand headings read in linear time', async () => {
        const fields = paragraph(`${field('TOC')}${END}`).repeat(8000);
        const headings = Array.from({ length: 8000 }, (_, index) => heading(`Heading ${index}`)).join('');
        const cpuMs = cpuClock();
        const { json } = await read(`${fields}${headings}`);
        expect(cpuMs()).toBeLessThan(3000);
        expect(nodesOfType(json, 'heading')).toHaveLength(8000);
    }, 60_000);
});
