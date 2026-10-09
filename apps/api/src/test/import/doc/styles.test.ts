import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { importDocxBody, marksOfType, nodesOfType } from '../../fixtures/golden-docx';

// What a paragraph style means: roles come from style names along the basedOn chain, which Word keeps English.

const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const styled = (style: string, text: string) => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${run(text)}</w:p>`;
const style = (id: string, name: string, extra = '') =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${extra}</w:style>`;
const types = (json: JSONContent) =>
    (json.content ?? []).map((node) => (node.type === 'heading' ? `heading${node.attrs?.['level']}` : node.type));

describe('code block language', () => {
    // The writer's carrier is the style's name; a LibreOffice re-save renames the id and keeps the name.
    const CODE_STYLES = `${style('CodeBlock', 'Code Block')}
${style('CodeBlockjavascript', 'Code Block (javascript)', '<w:basedOn w:val="CodeBlock"/>')}
${style('CodeBlock-python', 'Code Block (python)', '<w:basedOn w:val="CodeBlock"/>')}
${style('CodeBlock-klingon', 'Code Block (klingon)', '<w:basedOn w:val="CodeBlock"/>')}`;

    test('the language rides the style name, and blocks of two languages stay apart', async () => {
        const body = [
            styled('CodeBlockjavascript', 'const a = 1;'),
            styled('CodeBlockjavascript', 'const b = 2;'),
            styled('CodeBlock-python', 'print(a)'),
            styled('CodeBlock-klingon', 'Qapla'),
            styled('CodeBlock', 'plain'),
        ].join('');
        const { json } = await importDocxBody(body, { styles: CODE_STYLES });
        expect(
            nodesOfType(json, 'codeBlock').map((block) => [
                block.attrs?.['language'],
                nodesOfType(block, 'text')[0]?.text,
            ]),
        ).toEqual([
            ['javascript', 'const a = 1;\nconst b = 2;'],
            ['python', 'print(a)'],
            [null, 'Qapla\nplain'],
        ]);
    });
});

describe('roles', () => {
    test('headings by name whatever the id, Title as a heading, Subtitle as a paragraph', async () => {
        const styles = `${style('Kop2', 'heading 2')}${style('Titel', 'Title')}${style('Ondertitel', 'Subtitle')}`;
        const body = [styled('Kop2', 'Two'), styled('Titel', 'Title'), styled('Ondertitel', 'Sub')].join('');
        expect(types((await importDocxBody(body, { styles })).json)).toEqual(['heading2', 'heading1', 'paragraph']);
    });

    test("a custom style's outline level is a heading; a TOC entry's is not", async () => {
        const styles = `${style('Chapter', 'Chapter', '<w:pPr><w:outlineLvl w:val="1"/></w:pPr>')}${style('TOC1', 'toc 1', '<w:pPr><w:outlineLvl w:val="0"/></w:pPr>')}`;
        const body = [styled('Chapter', 'Chapter'), styled('TOC1', 'Entry')].join('');
        expect(types((await importDocxBody(body, { styles })).json)).toEqual(['heading2', 'paragraph']);
    });

    test("a heading style's bold is the heading's, no mark; a Quote's italic is the quote's", async () => {
        const styles = `${style('Heading2', 'heading 2', '<w:rPr><w:b/></w:rPr>')}${style('Quote', 'Quote', '<w:rPr><w:i/></w:rPr>')}`;
        const { json } = await importDocxBody(`${styled('Heading2', 'Head')}${styled('Quote', 'Said')}`, { styles });
        expect(types(json)).toEqual(['heading2', 'blockquote']);
        expect([...marksOfType(json, 'bold'), ...marksOfType(json, 'italic')]).toEqual([]);
    });

    // A heading draws its own size and weight; Word's italic Heading 4 and its color are looks Eigen's heading lacks.
    test("a heading style's italic and color stay marks, as its bold and size don't", async () => {
        const styles = style(
            'Heading4',
            'heading 4',
            '<w:rPr><w:b/><w:i/><w:color w:val="2F5496"/><w:sz w:val="28"/></w:rPr>',
        );
        const { json } = await importDocxBody(styled('Heading4', 'Four'), { styles });
        expect(types(json)).toEqual(['heading4']);
        expect(nodesOfType(json, 'text')[0]?.marks).toEqual([
            { type: 'textStyle', attrs: { color: '#2f5496', fontFamily: null } },
            { type: 'italic' },
        ]);
    });
});

// G6: a heading set in body-sized text by hand reads as body text in Word; size alone demotes nothing, as Word's
// Heading 4 to 6 are 11 pt on an 11 pt Normal.
describe('headings in body-sized text', () => {
    const STYLES = `<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>${style('Heading1', 'heading 1', '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr>')}${style('Heading4', 'heading 4', '<w:rPr><w:b/><w:i/></w:rPr>')}${style('Heading6', 'heading 6', '<w:rPr><w:sz w:val="20"/></w:rPr>')}`;
    const sized = (text: string, size?: number) =>
        `<w:r>${size ? `<w:rPr><w:sz w:val="${size}"/></w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
    const heading = (id: string, runs: string) => `<w:p><w:pPr><w:pStyle w:val="${id}"/></w:pPr>${runs}</w:p>`;
    const read = async (body: string) => {
        const { json } = await importDocxBody(body, { styles: STYLES });
        return {
            types: types(json),
            bold: marksOfType(json, 'bold').map((mark) => mark.text),
            italic: marksOfType(json, 'italic').map((mark) => mark.text),
        };
    };

    test('a Heading 1 whose runs all carry a direct size of 9 pt on an 11 pt body is a bold paragraph', async () => {
        expect(await read(heading('Heading1', `${sized('Small ', 18)}${sized('title', 18)}`))).toEqual({
            types: ['paragraph'],
            bold: ['Small title'],
            italic: [],
        });
    });

    test('a Heading 4 at the body size with no direct size stays a heading', async () => {
        expect(await read(heading('Heading4', sized('Four')))).toEqual({
            types: ['heading4'],
            bold: [],
            italic: ['Four'],
        });
    });

    test('a Heading 4 whose runs carry the body size directly is a bold italic paragraph', async () => {
        expect(await read(heading('Heading4', sized('Four', 20)))).toEqual({
            types: ['paragraph'],
            bold: ['Four'],
            italic: ['Four'],
        });
    });

    test.each([
        ['Heading 1 with a direct size above the body', heading('Heading1', sized('Big', 24)), 'heading1'],
        ['Heading 6 of 10 pt with its own size set directly', heading('Heading6', sized('Six', 20)), 'heading6'],
        [
            'Heading 1 with a run without a direct size',
            heading('Heading1', `${sized('Small ', 18)}${sized('and not')}`),
            'heading1',
        ],
    ])('a %s stays a heading', async (_name, body, type) => {
        expect((await read(body)).types).toEqual([type]);
    });
});
