import { describe, expect, test } from 'bun:test';
import { CODE_LOOK } from '../../../lib/export/doc/looks';
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
        const styles = '<w:style w:type="character" w:styleId="VerbatimChar"><w:name w:val="Verbatim Char"/></w:style>';
        const json = await imported(
            paragraph(
                `${run('styled', '<w:rStyle w:val="VerbatimChar"/>')}${run(' ')}${run('looked', `${font('JetBrains Mono')}<w:shd w:val="clear" w:fill="${CODE_LOOK.shading}"/>`)}`,
            ),
            { styles },
        );
        expect(marksOfType(json, 'code').map((mark) => mark.text)).toEqual(['styled', 'looked']);
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

    test("the Hyperlink style's theme color leaves the paragraph's color on a link", async () => {
        const styles =
            '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1" w:themeColor="hyperlink"/><w:u w:val="single"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Red"><w:name w:val="Red"/><w:rPr><w:color w:val="FF0000"/></w:rPr></w:style>';
        const json = await imported(
            paragraph(
                `<w:hyperlink r:id="rId9">${run('Red', '<w:rStyle w:val="Hyperlink"/>')}</w:hyperlink>`,
                '<w:pStyle w:val="Red"/>',
            ),
            {
                styles,
                rels: `<Relationship Id="rId9" Type="${HYPERLINK}" Target="https://example.com/" TargetMode="External"/>`,
            },
        );
        expect(marksOfType(json, 'textStyle').map((mark) => mark.attrs['color'])).toEqual(['#ff0000']);
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

describe('symbols', () => {
    test('a w:sym reads through its font, the private-use spelling too', async () => {
        const json = await imported(
            paragraph('<w:r><w:sym w:font="Symbol" w:char="B7"/><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>'),
        );
        expect(nodesOfType(json, 'text').map((node) => node.text)).toEqual(['•✓']);
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
});
