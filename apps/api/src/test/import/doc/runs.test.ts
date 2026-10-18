import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { MATH_LIMITS, type MathRow, writeMathml } from '@workspace/math';
import { writeZip } from '../../../lib/core/zip';
import { CODE_LOOK } from '../../../lib/document/looks';
import { docxToPmJson } from '../../../lib/import/doc/from-docx';
import { GOLDEN_DOCX_IMAGE_RUN, importDocxBody, marksOfType, nodesOfType } from '../../fixtures/golden-docx';

// A run's look: which marks Word's formatting becomes, and which it doesn't.

const run = (text: string, rPr = '') =>
    `<w:r>${rPr && `<w:rPr>${rPr}</w:rPr>`}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (inner: string, pPr = '') => `<w:p>${pPr && `<w:pPr>${pPr}</w:pPr>`}${inner}</w:p>`;
const font = (name: string) => `<w:rFonts w:ascii="${name}" w:hAnsi="${name}"/>`;
const imported = async (body: string, parts = {}) => (await importDocxBody(body, parts)).json;
const HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';

describe('colors', () => {
    // Google Docs writes black on every run; as a mark it would vanish on a dark page.
    test('explicit black and the body color are no mark, another color is', async () => {
        const styles =
            '<w:docDefaults><w:rPrDefault><w:rPr><w:color w:val="1F2937"/></w:rPr></w:rPrDefault></w:docDefaults>';
        const json = await imported(
            paragraph(
                `${run('black', '<w:color w:val="000000"/>')}${run('body', '<w:color w:val="1F2937"/>')}${run('red', '<w:color w:val="FF0000"/>')}`,
            ),
            { styles },
        );
        expect(marksOfType(json, 'textStyle').map((mark) => [mark.text, mark.attrs['color']])).toEqual([
            ['red', '#ff0000'],
        ]);
    });

    // ST_HexColor has no '#', but a converter writes one; Word reads the color.
    test("a color written with a leading '#' is that color", async () => {
        const json = await imported(paragraph(run('blue', '<w:color w:val="#1f497d"/>')));
        expect(marksOfType(json, 'textStyle').map((mark) => [mark.text, mark.attrs['color']])).toEqual([
            ['blue', '#1f497d'],
        ]);
    });

    test('yellow is the highlight without a color, white no highlight', async () => {
        const json = await imported(
            paragraph(
                `${run('yellow', '<w:highlight w:val="yellow"/>')}${run('white', '<w:highlight w:val="white"/>')}`,
            ),
        );
        expect(marksOfType(json, 'highlight').map((mark) => [mark.text, mark.attrs['color']])).toEqual([
            ['yellow', null],
        ]);
    });

    // ST_Shd: solid paints the pattern color over the fill, clear and nil leave the fill, the percentages blend the two.
    test('a solid shading is its pattern color, an auto one and any other pattern its fill', async () => {
        const shaded = (text: string, val: string, color: string, fill: string) =>
            `${run(text, `<w:shd w:val="${val}" w:color="${color}" w:fill="${fill}"/>`)}${run(' ')}`;
        const json = await imported(
            paragraph(
                shaded('solid', 'solid', '800080', 'FFFFFF') +
                    shaded('auto', 'solid', 'auto', 'FFE4B5') +
                    shaded('clear', 'clear', '800080', '00FF00') +
                    shaded('nil', 'nil', '800080', '0000FF') +
                    shaded('percent', 'pct25', '000000', 'FF0000') +
                    shaded('white', 'solid', 'FFFFFF', '000080'),
            ),
        );
        expect(marksOfType(json, 'highlight').map((mark) => [mark.text, mark.attrs['color']])).toEqual([
            ['solid', '#800080'],
            ['auto', '#ffe4b5'],
            ['clear', '#00ff00'],
            ['nil', '#0000ff'],
            ['percent', '#ff0000'],
        ]);
    });

    // Word draws auto text white on a dark shading or highlight; black on the highlight would be unreadable.
    test('auto text on a dark shading or highlight is white; a color, a lighter shading and a link keep theirs', async () => {
        const solid = (color: string) => `<w:shd w:val="solid" w:color="${color}" w:fill="FFFFFF"/>`;
        const json = await imported(
            paragraph(
                [
                    run('black', solid('000000')),
                    run('navy', '<w:highlight w:val="darkBlue"/>'),
                    run('auto', `<w:color w:val="auto"/>${solid('000000')}`),
                    run('red', `<w:color w:val="FF0000"/>${solid('000000')}`),
                    run('inked', `<w:color w:val="000000"/>${solid('000000')}`),
                    run('dim', solid('404040')),
                    run('grey', solid('808080')),
                    run('yellow', '<w:highlight w:val="yellow"/>'),
                    `<w:hyperlink r:id="rId9">${run('link', solid('000000'))}</w:hyperlink>`,
                ].join(run(' ')),
            ),
            {
                rels: `<Relationship Id="rId9" Type="${HYPERLINK}" Target="https://example.com/" TargetMode="External"/>`,
            },
        );
        expect(marksOfType(json, 'textStyle').map((mark) => [mark.text, mark.attrs['color']])).toEqual([
            ['black', '#ffffff'],
            ['navy', '#ffffff'],
            ['auto', '#ffffff'],
            ['red', '#ff0000'],
            ['dim', '#ffffff'],
        ]);
    });
});

describe('fonts and code', () => {
    // Decision 3: a foreign monospace run is a font; code comes from a code style or the editor's look.
    test('a Courier New run in a proportional body is JetBrains Mono, not code', async () => {
        const json = await imported(paragraph(`${run('Use ')}${run('npm install', font('Courier New'))}`));
        expect(marksOfType(json, 'code')).toEqual([]);
        expect(marksOfType(json, 'textStyle').map((mark) => [mark.text, mark.attrs['fontFamily']])).toEqual([
            ['npm install', 'JetBrains Mono'],
        ]);
    });

    test('a code character style is code, and JetBrains Mono on the code fill is code', async () => {
        const styles = `<w:style w:type="character" w:styleId="VerbatimChar"><w:name w:val="Verbatim Char"/><w:rPr>${font('Consolas')}</w:rPr></w:style>`;
        const json = await imported(
            paragraph(
                `${run('styled', '<w:rStyle w:val="VerbatimChar"/>')}${run(' ')}${run('looked', `${font('JetBrains Mono')}<w:shd w:val="clear" w:fill="${CODE_LOOK.shading}"/>`)}`,
            ),
            { styles },
        );
        expect(marksOfType(json, 'code').map((mark) => mark.text)).toEqual(['styled', 'looked']);
    });

    // Inline code needs a monospace run: a code style on a proportional run, or a run on a tinted fill, is no code.
    test('a code style on a Times run is no code; a monospace run on any light grey is, on a tint not', async () => {
        const styles = '<w:style w:type="character" w:styleId="VerbatimChar"><w:name w:val="Verbatim Char"/></w:style>';
        const shaded = (fill: string) => `${font('Courier New')}<w:shd w:val="clear" w:fill="${fill}"/>`;
        const json = await imported(
            paragraph(
                `${run('styled', `<w:rStyle w:val="VerbatimChar"/>${font('Times New Roman')}`)}${run(' ')}${run('grey', shaded('EEEEEE'))}${run(' ')}${run('tint', shaded('DDEEFF'))}`,
            ),
            { styles },
        );
        expect(marksOfType(json, 'code').map((mark) => mark.text)).toEqual(['grey']);
    });

    test('an Eigen font name stays, the document font is no mark', async () => {
        const json = await imported(paragraph(`${run('serif', font('Source Serif 4'))}${run('inter', font('Inter'))}`));
        expect(marksOfType(json, 'textStyle').map((mark) => [mark.text, mark.attrs['fontFamily']])).toEqual([
            ['serif', 'Source Serif 4'],
        ]);
    });
});

describe('toggles', () => {
    // Word XORs a toggle set by the paragraph style and by the character style; the run's own setting wins.
    test('bold in both styles is not bold, the run turning it back on is', async () => {
        const styles = `<w:style w:type="paragraph" w:styleId="Loud"><w:name w:val="Loud"/><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>`;
        const json = await imported(
            paragraph(
                `${run('both', '<w:rStyle w:val="Strong"/>')}${run('direct', '<w:rStyle w:val="Strong"/><w:b/>')}`,
                '<w:pStyle w:val="Loud"/>',
            ),
            { styles },
        );
        expect(marksOfType(json, 'bold').map((mark) => mark.text)).toEqual(['direct']);
    });
});

describe('underline', () => {
    // MS-OI29500 §2.1.100c: Word reads a w:u without w:val as inherited, so only a style underlines it.
    test('a w:u without w:val takes the style, else no underline', async () => {
        const styles =
            '<w:style w:type="character" w:styleId="Under"><w:name w:val="Under"/><w:rPr><w:u w:val="single"/></w:rPr></w:style>';
        const json = await imported(
            paragraph(
                `${run('plain', '<w:u w:color="000000"/>')}${run('styled', '<w:rStyle w:val="Under"/><w:u w:color="000000"/>')}${run(' ')}${run('single', '<w:u w:val="single"/>')}`,
            ),
            { styles },
        );
        expect(marksOfType(json, 'underline').map((mark) => mark.text)).toEqual(['styled', 'single']);
    });
});

describe('caps', () => {
    const capsOf = (json: JSONContent) =>
        marksOfType(json, 'textStyle').map((mark) => [mark.text, mark.attrs['caps'], mark.attrs['fontFamily']]);

    // Word draws capitals over both; the letters stay as typed.
    test('w:caps is all caps, w:smallCaps small caps, and caps win over both', async () => {
        const json = await imported(
            paragraph(
                `${run('Caps', '<w:caps/>')}${run('Small', `${font('Source Serif 4')}<w:smallCaps/>`)}${run('Both', '<w:smallCaps/><w:caps/>')}${run('Off', '<w:caps w:val="0"/>')}`,
            ),
        );
        expect(capsOf(json)).toEqual([
            ['Caps', 'all', null],
            ['Small', 'small', 'Source Serif 4'],
            ['Both', 'all', null],
        ]);
    });

    // A Title in caps is a title whose runs carry the style's caps: no node draws capitals.
    test("a style's caps are its runs' through basedOn, toggled by a character style, and the run's own setting wins", async () => {
        const styles = `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:caps/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Names"><w:name w:val="Names"/><w:rPr><w:smallCaps/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="MoreNames"><w:name w:val="More Names"/><w:basedOn w:val="Names"/></w:style>
<w:style w:type="character" w:styleId="Shout"><w:name w:val="Shout"/><w:rPr><w:caps/></w:rPr></w:style>`;
        const json = await imported(
            `${paragraph(`${run('Title')}${run(' plain', '<w:caps w:val="0"/>')}`, '<w:pStyle w:val="Title"/>')}${paragraph(run('Ada'), '<w:pStyle w:val="MoreNames"/>')}${paragraph(`${run('both', '<w:rStyle w:val="Shout"/>')}${run('direct', '<w:rStyle w:val="Shout"/><w:caps/>')}`, '<w:pStyle w:val="Title"/>')}`,
            { styles },
        );
        expect(nodesOfType(json, 'title')).toHaveLength(2);
        expect(capsOf(json)).toEqual([
            ['Title', 'all', null],
            ['Ada', 'small', null],
            ['direct', 'all', null],
        ]);
    });
});

describe('links', () => {
    test("a hyperlink keeps its tooltip as title and its anchor, and Word's link look is no mark", async () => {
        const json = await imported(
            paragraph(
                `<w:hyperlink r:id="rId9" w:anchor="part" w:tooltip="Read on">${run('Link', '<w:color w:val="0563C1"/><w:u w:val="single"/>')}</w:hyperlink>`,
            ),
            {
                rels: `<Relationship Id="rId9" Type="${HYPERLINK}" Target="https://example.com/page" TargetMode="External"/>`,
            },
        );
        expect(marksOfType(json, 'link').map((mark) => [mark.attrs['href'], mark.attrs['title']])).toEqual([
            ['https://example.com/page#part', 'Read on'],
        ]);
        expect([...marksOfType(json, 'textStyle'), ...marksOfType(json, 'underline')]).toEqual([]);
    });

    test("Google Docs' link look is no mark, a link's own color and underline are", async () => {
        const rels = `<Relationship Id="rId9" Type="${HYPERLINK}" Target="https://example.com/" TargetMode="External"/>`;
        const json = await imported(
            paragraph(
                `<w:hyperlink r:id="rId9">${run('Google', '<w:color w:val="1155CC"/><w:u w:val="single"/>')}${run('Own', '<w:color w:val="FF0000"/><w:u w:val="single"/>')}</w:hyperlink>`,
            ),
            { rels },
        );
        expect(marksOfType(json, 'textStyle').map((mark) => [mark.text, mark.attrs['color']])).toEqual([
            ['Own', '#ff0000'],
        ]);
        expect(marksOfType(json, 'underline').map((mark) => mark.text)).toEqual(['Own']);
    });

    // Word 2007's theme draws a link in 0000FF, Office 2023's in 467886: the run names the theme's color as well.
    test("a color from the theme's hyperlink colors is the link look, a link's own color is not", async () => {
        const rels = `<Relationship Id="rId9" Type="${HYPERLINK}" Target="https://example.com/" TargetMode="External"/>`;
        const json = await imported(
            paragraph(
                `<w:hyperlink r:id="rId9">${run('New', '<w:color w:val="467886" w:themeColor="hyperlink"/><w:u w:val="single"/>')}${run('Old', '<w:color w:val="0000FF" w:themeColor="hyperlink"/><w:u w:val="single"/>')}${run('Visited', '<w:color w:val="954F72" w:themeColor="followedHyperlink"/><w:u w:val="single"/>')}${run('Own', '<w:color w:val="FF0000"/>')}</w:hyperlink>`,
            ),
            { rels },
        );
        expect(marksOfType(json, 'textStyle').map((mark) => [mark.text, mark.attrs['color']])).toEqual([
            ['Own', '#ff0000'],
        ]);
        expect(marksOfType(json, 'underline')).toEqual([]);
    });

    // Word draws the character style's color over the paragraph style's, so a link in a colored heading is the link look.
    test("the Hyperlink style's theme color covers the heading's color on a link; a plain run keeps the heading's", async () => {
        const styles =
            '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1" w:themeColor="hyperlink"/><w:u w:val="single"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:color w:val="2F5496"/></w:rPr></w:style>';
        const json = await imported(
            paragraph(
                `${run('Read ')}<w:hyperlink r:id="rId9">${run('Linked', '<w:rStyle w:val="Hyperlink"/>')}${run(' bare')}</w:hyperlink>`,
                '<w:pStyle w:val="Heading1"/>',
            ),
            {
                styles,
                rels: `<Relationship Id="rId9" Type="${HYPERLINK}" Target="https://example.com/" TargetMode="External"/>`,
            },
        );
        expect(marksOfType(json, 'link').map((mark) => mark.text)).toEqual(['Linked', ' bare']);
        expect(marksOfType(json, 'textStyle').map((mark) => [mark.text, mark.attrs['color']])).toEqual([
            ['Read ', '#2f5496'],
            [' bare', '#2f5496'],
        ]);
    });

    // Word draws a custom Hyperlink style's color and underline; only a known link look is the editor's to draw.
    test("a Hyperlink style in a color of its own keeps its color and underline; Word's link look covers the paragraph's", async () => {
        const hyperlink = (id: string, color: string) =>
            `<w:style w:type="character" w:styleId="${id}"><w:name w:val="${id}"/><w:rPr><w:color ${color}/><w:u w:val="single"/></w:rPr></w:style>`;
        const linked = (text: string, style: string) =>
            `<w:hyperlink r:id="rId9">${run(text, `<w:rStyle w:val="${style}"/>`)}</w:hyperlink>`;
        const json = await imported(
            paragraph(
                `${linked('Pink', 'Hyperlink')}${linked('Word', 'WordLink')}${linked('Old', 'OldLink')}${linked('Navy', 'InternetLink')}${linked('Theme', 'ThemeLink')}`,
                '<w:pStyle w:val="Red"/>',
            ),
            {
                styles: `<w:style w:type="paragraph" w:styleId="Red"><w:name w:val="Red"/><w:rPr><w:color w:val="FF0000"/></w:rPr></w:style>${hyperlink('Hyperlink', 'w:val="E91D63"')}${hyperlink('WordLink', 'w:val="0563C1"')}${hyperlink('OldLink', 'w:val="0000FF"')}${hyperlink('InternetLink', 'w:val="000080"')}${hyperlink('ThemeLink', 'w:val="467886" w:themeColor="hyperlink"')}`,
                rels: `<Relationship Id="rId9" Type="${HYPERLINK}" Target="https://example.com/" TargetMode="External"/>`,
            },
        );
        expect(marksOfType(json, 'textStyle').map((mark) => [mark.text, mark.attrs['color']])).toEqual([
            ['Pink', '#e91d63'],
        ]);
        expect(marksOfType(json, 'underline').map((mark) => mark.text)).toEqual(['Pink']);
    });

    // A quote or a done task draws its own color, so its style's hyperlink theme is no link look.
    test("a quote's or done task's hyperlink-theme color leaves a link's own underline a mark", async () => {
        const style = (id: string, name: string) =>
            `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:rPr><w:color w:val="0563C1" w:themeColor="hyperlink"/></w:rPr></w:style>`;
        const linked = (text: string, pStyle: string) =>
            paragraph(
                `<w:hyperlink r:id="rId9">${run(text, '<w:u w:val="single"/>')}</w:hyperlink>`,
                `<w:pStyle w:val="${pStyle}"/>`,
            );
        const json = await imported(`${linked('Quoted', 'Quote')}${linked('Done', 'TaskDone')}`, {
            styles: `${style('Quote', 'Quote')}${style('TaskDone', 'Task Done')}`,
            rels: `<Relationship Id="rId9" Type="${HYPERLINK}" Target="https://example.com/" TargetMode="External"/>`,
        });
        expect(marksOfType(json, 'link').map((mark) => mark.text)).toEqual(['Quoted', 'Done']);
        expect(marksOfType(json, 'underline').map((mark) => mark.text)).toEqual(['Quoted', 'Done']);
    });

    // Eigen holds no bookmarks, so a link to one is its text in the run's look; Word draws a TOC entry's link style in
    // its paragraph's look. The writer's in-document link rides on a relationship, which keeps it.
    test("a link to a bookmark is no link: its text keeps its own look, its link style's outside a TOC", async () => {
        const styles =
            '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1" w:themeColor="hyperlink"/><w:u w:val="single"/></w:rPr></w:style>';
        const linked = (text: string) => run(text, '<w:rStyle w:val="Hyperlink"/><w:b/>');
        const begin = (code: string) =>
            `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${code} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>`;
        const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
        const json = await imported(
            [
                // A table of contents is a field around its entries' paragraphs.
                paragraph(
                    `${begin('TOC \\o "1-3" \\h')}<w:hyperlink w:anchor="_Toc1">${linked('Entry')}</w:hyperlink>`,
                ),
                paragraph(`${begin('HYPERLINK \\l "_Toc2"')}${linked('Field')}${end}${end}`),
                paragraph(`<w:hyperlink w:anchor="ref1">${linked('Reference')}</w:hyperlink>`),
                paragraph(
                    `<w:hyperlink w:anchor="ref2">${run('Direct', '<w:color w:val="1155cc"/><w:u w:val="single"/>')}</w:hyperlink>`,
                ),
                paragraph(`<w:hyperlink r:id="rId9">${linked('Writer')}</w:hyperlink>`),
            ].join(''),
            { styles, rels: `<Relationship Id="rId9" Type="${HYPERLINK}" Target="#part" TargetMode="External"/>` },
        );
        expect(nodesOfType(json, 'text').map((node) => [node.text, node.marks?.map((mark) => mark.type)])).toEqual([
            ['Entry', ['bold']],
            ['Field', ['bold']],
            ['Reference', ['textStyle', 'bold', 'underline']],
            ['Direct', ['textStyle', 'underline']],
            ['Writer', ['link', 'bold']],
        ]);
        expect(marksOfType(json, 'textStyle').map((mark) => [mark.text, mark.attrs['color']])).toEqual([
            ['Reference', '#0563c1'],
            ['Direct', '#1155cc'],
        ]);
        expect(marksOfType(json, 'link').map((mark) => mark.attrs['href'])).toEqual(['#part']);
    });

    test('a HYPERLINK field links its result and drops its code', async () => {
        const json = await imported(
            paragraph(
                '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://example.com/" \\o "Tip" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Result</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>',
            ),
        );
        expect(nodesOfType(json, 'text').map((node) => node.text)).toEqual(['Result']);
        expect(marksOfType(json, 'link').map((mark) => [mark.attrs['href'], mark.attrs['title']])).toEqual([
            ['https://example.com/', 'Tip'],
        ]);
    });
});

describe('text', () => {
    // Pandoc ends a w:t with a line feed and no xml:space; Word shows question2, not question 2.
    test("a w:t's surrounding whitespace is dropped unless xml:space preserves it", async () => {
        const json = await imported(
            paragraph(
                '<w:r><w:t>question\n</w:t></w:r><w:r><w:t>2</w:t></w:r><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:r><w:t>\t more\nthan\u00a0</w:t></w:r><w:r><w:t> </w:t></w:r><w:r><w:t>one</w:t></w:r>',
            ),
        );
        expect(nodesOfType(json, 'text').map((node) => node.text)).toEqual(['question2 and more than\u00a0one']);
    });
});

describe('symbols', () => {
    test('a w:sym reads through its font, the private-use spelling too', async () => {
        const json = await imported(
            paragraph('<w:r><w:sym w:font="Symbol" w:char="B7"/><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>'),
        );
        expect(nodesOfType(json, 'text').map((node) => node.text)).toEqual(['•✓']);
    });
});

describe('math', () => {
    const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
    const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
    const r = (text: string) => `<m:r><m:t>${text}</m:t></m:r>`;
    const oMath = (inner: string, ns = M) => `<m:oMath xmlns:m="${ns}">${inner}</m:oMath>`;
    const SQUARE = `<m:sSup><m:e>${r('x')}</m:e><m:sup>${r('2')}</m:sup></m:sSup>${r('+1')}`;
    const SQUARE_ROW: MathRow = [
        { kind: 'scripts', base: [{ kind: 'identifier', text: 'x' }], sup: [{ kind: 'number', text: '2' }] },
        { kind: 'operator', text: '+' },
        { kind: 'number', text: '1' },
    ];
    const equation = (row: MathRow, display = false) => ({
        type: 'equation',
        attrs: { mathml: writeMathml(row), display, commentCardId: null },
    });
    const id = (text: string): MathRow => [{ kind: 'identifier', text }];
    const contents = (json: JSONContent) => json.content?.map((block) => block.content);

    test('an equation in a sentence is an inline equation node between its runs', async () => {
        const json = await imported(paragraph(`${run('So ')}${oMath(SQUARE)}${run(' holds.')}`));
        expect(contents(json)).toEqual([
            [{ type: 'text', text: 'So ' }, equation(SQUARE_ROW), { type: 'text', text: ' holds.' }],
        ]);
    });

    test('each m:oMath of an m:oMathPara is a display equation, and text beside it stays in its paragraph', async () => {
        const para = `<m:oMathPara xmlns:m="${M}"><m:oMathParaPr><m:jc m:val="left"/></m:oMathParaPr><m:oMath>${r('a')}</m:oMath><m:oMath>${r('b')}</m:oMath></m:oMathPara>`;
        const json = await imported(`${paragraph(para)}${paragraph(`${run('Where ')}${para}${run(' holds.')}`)}`);
        expect(contents(json)).toEqual([
            [equation(id('a'), true), equation(id('b'), true)],
            [
                { type: 'text', text: 'Where ' },
                equation(id('a'), true),
                equation(id('b'), true),
                { type: 'text', text: ' holds.' },
            ],
        ]);
    });

    test('a tracked deletion in an equation is gone, an insertion kept; a deleted equation is no node', async () => {
        const tracked = `<m:r><w:del w:id="1" w:author="a"><m:t>y</m:t></w:del></m:r><m:r><w:ins w:id="2" w:author="a"><m:t>x</m:t></w:ins></m:r>`;
        const json = await imported(
            paragraph(`${oMath(tracked)}<w:del w:id="3" w:author="a">${oMath(r('z'))}</w:del>`),
        );
        expect(contents(json)).toEqual([[equation(id('x'))]]);
    });

    test('an equation in Strict OOXML reads as its transitional twin', async () => {
        const strict = 'http://purl.oclc.org/ooxml';
        const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${strict}/officeDocument/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
        const body = `<w:p>${oMath(SQUARE, `${strict}/officeDocument/math`)}</w:p>`;
        const docx = writeZip(
            Object.entries({
                '_rels/.rels': rels,
                'word/document.xml': `<w:document xmlns:w="${strict}/wordprocessingml/main"><w:body>${body}</w:body></w:document>`,
            }).map(([name, data]) => ({ name, data })),
        );
        expect(contents(docxToPmJson(Buffer.from(docx)).json)).toEqual([[equation(SQUARE_ROW)]]);
    });

    // Runs side by side are one word and each object is its own, so x²+1 reads x2 +1.
    test('an equation nested past the bound is its text, a tracked deletion left out', async () => {
        const deep = `${'<m:d><m:e>'.repeat(MATH_LIMITS.depth)}${SQUARE}${'</m:e></m:d>'.repeat(MATH_LIMITS.depth)}`;
        const json = await imported(
            paragraph(
                `${run('So ')}${oMath(`${deep}<m:r><w:del w:id="1" w:author="a"><m:t>y</m:t></w:del></m:r>${SQUARE}`)}`,
            ),
        );
        expect(contents(json)).toEqual([[{ type: 'text', text: 'So x2+1 x2 +1' }]]);
    });

    // As inlineText sets an equation off from the text beside it.
    test('the text of an equation past the bound is set off from its neighbours by a space where none is', async () => {
        const deep = (text: string) =>
            oMath(`${'<m:d><m:e>'.repeat(MATH_LIMITS.depth)}${r(text)}${'</m:e></m:d>'.repeat(MATH_LIMITS.depth)}`);
        const sentence = paragraph(`${run('see')}${deep('A')}${run('and')}${deep('B')}${run(' too')}`);
        const display = paragraph(`<m:oMathPara xmlns:m="${M}">${deep('A')}${deep('B')}</m:oMathPara>`);
        expect(contents(await imported(`${sentence}${display}`))).toEqual([
            [{ type: 'text', text: 'see A and B too' }],
            [{ type: 'text', text: 'A B' }],
        ]);
    });

    test("an equation's text joins neighbouring runs into one word and breaks at an object", async () => {
        const runs = `${r('x')}${r('+1')}`;
        const deep = `${'<m:d><m:e>'.repeat(MATH_LIMITS.depth)}${runs}${'</m:e></m:d>'.repeat(MATH_LIMITS.depth)}`;
        const json = await imported(paragraph(oMath(`${runs}${deep}${runs}`)));
        expect(contents(json)).toEqual([[{ type: 'text', text: 'x+1 x+1 x+1' }]]);
    });

    // Word sets a function name, a unit or the d of dx upright through the run's m:rPr.
    test("a run's properties start no word in an equation's text", async () => {
        const runs = `${r('x')}<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>+1</m:t></m:r>`;
        const deep = `${'<m:d><m:e>'.repeat(MATH_LIMITS.depth)}${runs}${'</m:e></m:d>'.repeat(MATH_LIMITS.depth)}`;
        const json = await imported(paragraph(oMath(`${runs}${deep}${runs}`)));
        expect(contents(json)).toEqual([[{ type: 'text', text: 'x+1 x+1 x+1' }]]);
    });

    // As the package reads it: an alternative's fallback, and no object a tracked deletion of its control deletes, so f
    // and w are neighbouring runs.
    test("an equation's text reads an alternative's fallback and leaves out an object whose control is deleted", async () => {
        const deep = `${'<m:d><m:e>'.repeat(MATH_LIMITS.depth)}${r('x')}${'</m:e></m:d>'.repeat(MATH_LIMITS.depth)}`;
        const alternative = `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice Requires="w14">${r('c')}</mc:Choice><mc:Fallback>${r('f')}</mc:Fallback></mc:AlternateContent>`;
        const deleted = `<m:sSup><m:sSupPr><m:ctrlPr><w:del w:id="1" w:author="a"><w:rPr/></w:del></m:ctrlPr></m:sSupPr><m:e>${r('z')}</m:e><m:sup>${r('3')}</m:sup></m:sSup>`;
        const json = await imported(paragraph(oMath(`${deep}${alternative}${deleted}${r('w')}`)));
        expect(contents(json)).toEqual([[{ type: 'text', text: 'x fw' }]]);
    });

    test('an m:oMathPara holds only its own m:oMath: a deleted one or one in an alternative is none', async () => {
        const para = `<m:oMathPara xmlns:m="${M}" xmlns:mc="${MC}"><w:del w:id="1" w:author="a"><m:oMath>${r('d')}</m:oMath></w:del><mc:AlternateContent><mc:Choice Requires="w14"><m:oMath>${r('c')}</m:oMath></mc:Choice><mc:Fallback><m:oMath>${r('f')}</m:oMath></mc:Fallback></mc:AlternateContent><m:oMath>${r('b')}</m:oMath></m:oMathPara>`;
        expect(contents(await imported(paragraph(para)))).toEqual([[equation(id('b'), true)]]);
    });

    // A caption is plain text: a block figure's Caption line, and the writer's floating one-cell table.
    test("an equation in a figure's caption is its linear text there", async () => {
        const styles = '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/></w:style>';
        const caption = paragraph(`${run('Figure 1: ')}${oMath(SQUARE)}`, '<w:pStyle w:val="Caption"/>');
        const float = `<w:tbl><w:tblPr><w:tblpPr w:tblpXSpec="right"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc>${paragraph(GOLDEN_DOCX_IMAGE_RUN)}${paragraph(oMath(r('y')))}</w:tc></w:tr></w:tbl>`;
        const { json } = await importDocxBody(`${paragraph(GOLDEN_DOCX_IMAGE_RUN)}${caption}${float}`, { styles });
        expect(nodesOfType(json, 'figure').map((node) => node.attrs?.['caption'])).toEqual(['Figure 1: x^2+1', 'y']);
        expect(nodesOfType(json, 'equation')).toEqual([]);
    });

    test('equations and text side by side are set off by a space where none is', async () => {
        const styles = '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/></w:style>';
        const caption = paragraph(
            `${run('Fig')}${oMath(r('a'))}${oMath(r('b'))}${run('c')}${oMath(r('d'))}${run(' e')}`,
            '<w:pStyle w:val="Caption"/>',
        );
        const { json } = await importDocxBody(`${paragraph(GOLDEN_DOCX_IMAGE_RUN)}${caption}`, { styles });
        expect(nodesOfType(json, 'figure').map((node) => node.attrs?.['caption'])).toEqual(['Fig a b c d e']);
    });

    test('an equation in a code block is its linear text', async () => {
        const consolas = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>';
        const json = await imported(
            paragraph(
                `${run('y = ', consolas)}${oMath(SQUARE)}`,
                '<w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/>',
            ),
        );
        expect(json.content?.map((block) => [block.type, block.content])).toEqual([
            ['codeBlock', [{ type: 'text', text: 'y = x^2+1' }]],
        ]);
    });
});

describe('sizes', () => {
    const sizesOf = (json: JSONContent) =>
        marksOfType(json, 'textStyle')
            .filter((mark) => mark.attrs['fontSize'] !== null)
            .map((mark) => [mark.text, mark.attrs['fontSize']]);
    const BODY_11 = '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>';

    // ST_HpsMeasure: half-points, or a universal measure in Strict OOXML. Small is the editor's no longer.
    test('a run in a size other than the body has it in pt, one at the body size none', async () => {
        const json = await imported(
            paragraph(
                `${run('fine', '<w:sz w:val="8pt"/>')}${run(' body', '<w:sz w:val="11pt"/>')}${run(' big', '<w:sz w:val="28"/>')}${run(' half', '<w:sz w:val="21"/>')}`,
            ),
            { styles: BODY_11 },
        );
        expect(sizesOf(json)).toEqual([
            ['fine', 8],
            [' big', 14],
            [' half', 10.5],
        ]);
        expect(marksOfType(json, 'small')).toEqual([]);
    });

    // The docx's own body is the doc's body, whatever its size: a 12 pt Word body draws as the doc's 11 pt.
    test('on a 12 pt body its runs have no size, and an 11 pt run has one', async () => {
        const styles = `${BODY_11}<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/><w:basedOn w:val="Normal"/></w:style>`;
        const json = await imported(
            `${paragraph(`${run('plain')}${run(' set', '<w:sz w:val="24"/>')}${run(' less', '<w:sz w:val="22"/>')}`)}${paragraph(run('styled'), '<w:pStyle w:val="BodyText"/>')}`,
            { styles },
        );
        expect(sizesOf(json)).toEqual([[' less', 11]]);
    });

    // P8: the body is what's normal; 9 pt in a 9 pt body is body text.
    test('9 pt runs on a 9 pt body have no size', async () => {
        const styles = '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="18"/></w:rPr></w:rPrDefault></w:docDefaults>';
        const json = await imported(paragraph(run('body', '<w:sz w:val="18"/>')), { styles });
        expect(sizesOf(json)).toEqual([]);
    });

    // A heading draws its own size, as it does its bold; a run set apart from the style keeps its own.
    test("a heading's style size is no mark, a run's own size is", async () => {
        const styles = `${BODY_11}<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>`;
        const json = await imported(
            paragraph(
                `${run('Plan')}${run(' as styled', '<w:sz w:val="32"/>')}${run(' big', '<w:sz w:val="40"/>')}`,
                '<w:pStyle w:val="Heading1"/>',
            ),
            { styles },
        );
        expect(nodesOfType(json, 'heading')).toHaveLength(1);
        expect(sizesOf(json)).toEqual([[' big', 20]]);
    });

    // A hostile w:sz reaches the page's CSS and WeasyPrint, so it lands in the editor's range.
    test("a size past Word's lands in Google's 1 to 400 pt", async () => {
        const json = await imported(
            paragraph(`${run('huge', '<w:sz w:val="99999"/>')}${run(' none', '<w:sz w:val="0"/>')}`),
            { styles: BODY_11 },
        );
        expect(sizesOf(json)).toEqual([
            ['huge', 400],
            [' none', 1],
        ]);
    });
});

describe('complex script', () => {
    // Word draws a complex script character, and every character of a run marked rtl, with bCs, iCs and szCs.
    test('an Arabic run with bCs alone is bold, a Latin one is not, and an rtl run is complex throughout', async () => {
        const json = await imported(
            paragraph(
                `${run('إسبانيا', '<w:bCs/><w:rtl/>')}${run(' Spain ', '<w:bCs/>')}${run('مملكة', '<w:b/>')}${run(' (Reino)', '<w:bCs/><w:rtl/>')}`,
            ),
        );
        expect(marksOfType(json, 'bold').map((mark) => mark.text)).toEqual(['إسبانيا', ' (Reino)']);
    });

    test('in one run Arabic takes iCs and szCs, Latin i and sz, either splitting the run alone', async () => {
        const styles =
            '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>';
        const json = await imported(
            `${paragraph(run('Spain مملكة', '<w:i/>'))}${paragraph(run('Spain مملكة', '<w:szCs w:val="14"/>'))}`,
            { styles },
        );
        expect(marksOfType(json, 'italic').map((mark) => mark.text)).toEqual(['Spain ']);
        expect(
            marksOfType(json, 'textStyle')
                .filter((mark) => mark.attrs['fontSize'] !== null)
                .map((mark) => [mark.text, mark.attrs['fontSize']]),
        ).toEqual([['مملكة', 7]]);
    });

    test("bCs toggles through the styles as b does, and a heading's is its own", async () => {
        const styles = `<w:style w:type="paragraph" w:styleId="Loud"><w:name w:val="Loud"/><w:rPr><w:bCs/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:bCs/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:rPr><w:bCs/></w:rPr></w:style>`;
        const json = await imported(
            `${paragraph(`${run('مملكة')}${run(' إسبانيا', '<w:rStyle w:val="Strong"/>')}`, '<w:pStyle w:val="Loud"/>')}${paragraph(run('عنوان'), '<w:pStyle w:val="Heading2"/>')}`,
            { styles },
        );
        expect(marksOfType(json, 'bold').map((mark) => mark.text)).toEqual(['مملكة']);
        expect(nodesOfType(json, 'heading')).toHaveLength(1);
    });
});
