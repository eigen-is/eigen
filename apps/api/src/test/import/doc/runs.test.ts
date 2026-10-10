import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { CODE_LOOK } from '../../../lib/document/looks';
import { importDocxBody, marksOfType, nodesOfType } from '../../fixtures/golden-docx';

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

    // A Title in caps is a heading whose runs carry the style's caps: no node draws capitals.
    test("a style's caps are its runs' through basedOn, toggled by a character style, and the run's own setting wins", async () => {
        const styles = `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:caps/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Names"><w:name w:val="Names"/><w:rPr><w:smallCaps/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="MoreNames"><w:name w:val="More Names"/><w:basedOn w:val="Names"/></w:style>
<w:style w:type="character" w:styleId="Shout"><w:name w:val="Shout"/><w:rPr><w:caps/></w:rPr></w:style>`;
        const json = await imported(
            `${paragraph(`${run('Title')}${run(' plain', '<w:caps w:val="0"/>')}`, '<w:pStyle w:val="Title"/>')}${paragraph(run('Ada'), '<w:pStyle w:val="MoreNames"/>')}${paragraph(`${run('both', '<w:rStyle w:val="Shout"/>')}${run('direct', '<w:rStyle w:val="Shout"/><w:caps/>')}`, '<w:pStyle w:val="Title"/>')}`,
            { styles },
        );
        expect(nodesOfType(json, 'heading')).toHaveLength(2);
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

    // Eigen holds no bookmarks, and Word draws a TOC entry's link in its paragraph's look; the writer's in-document
    // link rides on a relationship, which keeps it.
    test("a link to a bookmark is its text in its own marks, no link and no link look; a relationship's #anchor links", async () => {
        const styles =
            '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1" w:themeColor="hyperlink"/><w:u w:val="single"/></w:rPr></w:style>';
        const linked = (text: string) => run(text, '<w:rStyle w:val="Hyperlink"/><w:b/>');
        const json = await imported(
            `${paragraph(`<w:hyperlink w:anchor="_Toc1" w:history="1">${linked('Element')}</w:hyperlink>`)}${paragraph(`<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK \\l "_Toc2" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${linked('Field')}<w:r><w:fldChar w:fldCharType="end"/></w:r>`)}${paragraph(`<w:hyperlink r:id="rId9">${linked('Writer')}</w:hyperlink>`)}`,
            { styles, rels: `<Relationship Id="rId9" Type="${HYPERLINK}" Target="#part" TargetMode="External"/>` },
        );
        expect(nodesOfType(json, 'text').map((node) => [node.text, node.marks?.map((mark) => mark.type)])).toEqual([
            ['Element', ['bold']],
            ['Field', ['bold']],
            ['Writer', ['link', 'bold']],
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
    // G14: math reads as text, each object and run its own word, so x²+1 is no one word.
    test('OMML objects and runs side by side are spaced', async () => {
        const math = `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup><m:r><m:t>+1</m:t></m:r></m:oMath>`;
        const json = await imported(paragraph(`${run('So ')}${math}`));
        expect(nodesOfType(json, 'text').map((node) => node.text)).toEqual(['So x2 +1']);
    });
});

describe('sizes', () => {
    // ST_HpsMeasure: half-points, or a universal measure in Strict OOXML.
    test('a run of 8pt on an 11 pt body is small, one of 11pt is not', async () => {
        const styles = '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>';
        const json = await imported(
            paragraph(`${run('fine', '<w:sz w:val="8pt"/>')}${run(' body', '<w:sz w:val="11pt"/>')}`),
            { styles },
        );
        expect(marksOfType(json, 'small').map((mark) => mark.text)).toEqual(['fine']);
    });

    // P8: small is relative to the body; 9 pt in a 9 pt body is body text.
    test('9 pt runs on a 9 pt body are not small', async () => {
        const styles = '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="18"/></w:rPr></w:rPrDefault></w:docDefaults>';
        const json = await imported(paragraph(run('body', '<w:sz w:val="18"/>')), { styles });
        expect(marksOfType(json, 'small')).toEqual([]);
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
        expect(marksOfType(json, 'small').map((mark) => mark.text)).toEqual(['مملكة']);
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
