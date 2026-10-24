import { describe, expect, test } from 'bun:test';
import { MAX_HTML_BYTES } from '@workspace/lib/vector';
import type { XmlElement } from '../../../lib/core/xml';
import { xmlChild } from '../../../lib/core/xml';
import { readPptx } from '../../../lib/import/slides/from-pptx';
import type { SlideTheme } from '../../../lib/import/slides/inherit';
import { richTextOf } from '../../../lib/import/slides/text';
import { A_NS, parseOoxml } from '../../../lib/ooxml/ooxml';
import type { Relationship } from '../../../lib/ooxml/opc';
import { box, buildPptx, countVisits, NS, para, REL, rel, run, sp } from '../../fixtures/pptx';

// A text body as one rich-text box: its paragraphs as HTML, the box styled by the run most of its text is in, every
// property inherited down the chain from the run to the master's text styles.

const THEME: SlideTheme = {
    colors: {
        scheme: new Map([
            ['dk1', '#000000'],
            ['lt1', '#ffffff'],
            ['accent1', '#4f81bd'],
            ['accent2', '#c0504d'],
        ]),
        map: new Map([
            ['tx1', 'dk1'],
            ['bg1', 'lt1'],
            ['accent1', 'accent1'],
            ['accent2', 'accent2'],
        ]),
    },
    fonts: { major: 'Georgia', minor: 'Consolas' },
    formats: { fills: [], backgrounds: [], lines: [] },
};

const UNCOUNTED = () => {};

// PowerPoint's widescreen, 13.33 in: 6,350 EMU a px, and a point is 2 px.
const WIDE_DECK = { scale: 1 / 6350, slideWidth: 960 };

const parse = (xml: string) => {
    const element = parseOoxml(xml);
    if (!element) throw new Error(`not XML: ${xml}`);
    return element;
};

const txBody = (paragraphs: string, bodyPr = '', lstStyle = '') =>
    parse(`<p:txBody ${NS}><a:bodyPr${bodyPr}/><a:lstStyle>${lstStyle}</a:lstStyle>${paragraphs}</p:txBody>`);

// A placeholder's body as its part reads it.
const inheritedOf = (body: XmlElement) => ({
    bodyPr: xmlChild(body, A_NS, 'bodyPr'),
    listStyle: xmlChild(body, A_NS, 'lstStyle'),
});

type Source = {
    bodyPr?: string;
    lstStyle?: string;
    // The layout's and the master's placeholder bodies, as [bodyPr attributes, lstStyle content].
    inherited?: [string, string][];
    listStyle?: string;
    style?: string;
    rels?: Map<string, Relationship>;
};

function textOf(paragraphs: string, source: Source = {}) {
    return richTextOf(
        {
            body: txBody(paragraphs, source.bodyPr, source.lstStyle),
            inherited: (source.inherited ?? []).map(([bodyPr, lstStyle]) => inheritedOf(txBody('', bodyPr, lstStyle))),
            listStyle:
                source.listStyle === undefined
                    ? undefined
                    : parse(`<p:bodyStyle ${NS}>${source.listStyle}</p:bodyStyle>`),
            style: source.style === undefined ? undefined : parse(`<p:style ${NS}>${source.style}</p:style>`),
            rels: source.rels ?? new Map(),
        },
        THEME,
        WIDE_DECK,
        UNCOUNTED,
    );
}

const level = (n: number, attributes = '', inner = '') => `<a:lvl${n}pPr${attributes}>${inner}</a:lvl${n}pPr>`;
const defRPr = (attributes: string, inner = '') => `<a:defRPr${attributes}>${inner}</a:defRPr>`;
const sized = (hundredths: number) => level(1, '', defRPr(` sz="${hundredths}"`));
const fontRef = (idx: string, color = '') =>
    `<a:lnRef idx="0"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="${idx}">${color}</a:fontRef>`;
const schemeFill = (slot: string) => `<a:solidFill><a:schemeClr val="${slot}"/></a:solidFill>`;
const bulleted = (paragraph: string, lvl = 0, inner = '') =>
    `<a:p><a:pPr lvl="${lvl}">${inner}</a:pPr>${run(paragraph)}</a:p>`;

describe('a text body', () => {
    test('is one paragraph each, escaped, its breaks, fields and tabs kept', () => {
        const html = textOf(
            `${para('a &lt;b&gt; &amp; "c"')}<a:p>${run('one')}<a:br/>${run('two')}<a:fld id="{1}" type="slidenum"><a:t>3</a:t></a:fld></a:p><a:p/>${para('x\ty')}`,
        )?.html;
        expect(html).toBe('<p>a &lt;b&gt; &amp; &quot;c&quot;</p><p>one<br>two3</p><p></p><p>x y</p>');
    });

    test("unwraps markup compatibility inside a paragraph, taking the choice PowerPoint's reader can read", () => {
        const choice = (requires: string) =>
            `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="${requires}">${run('choice')}</mc:Choice><mc:Fallback>${run('fallback')}</mc:Fallback></mc:AlternateContent>`;
        expect(textOf(`<a:p>${run('a ')}${choice('a14')}</a:p>`)?.html).toBe('<p>a fallback</p>');
        expect(textOf(`<a:p>${run('a ')}${choice('a')}</a:p>`)?.html).toBe('<p>a choice</p>');
    });

    test('with no visible text is none', () => {
        expect(textOf('<a:p/>')).toBeUndefined();
        expect(textOf(para('   '))).toBeUndefined();
    });

    test('takes its box style from the run that covers the most characters', () => {
        const heading = `${schemeFill('accent1')}<a:latin typeface="+mj-lt"/>`;
        const found = textOf(
            `<a:p>${run('tiny', ' sz="800" b="1"')}${run('most of the text', ' sz="2400" i="1" u="sng"', heading)}</a:p>`,
        );
        expect(found).toMatchObject({
            fontSize: 48,
            color: '#4f81bd',
            fontFamily: 'Source Serif 4',
            fontWeight: 'normal',
            fontStyle: 'normal',
            textDecoration: 'none',
        });
        // Each run keeps its marks inline; the smaller one's size is lost.
        expect(found?.html).toBe('<p><strong>tiny</strong><em><u>most of the text</u></em></p>');
        expect(textOf(para('plain'))).toMatchObject({ fontSize: 36, color: '#000000', fontFamily: 'Inter' });
    });

    test(`is cut at a paragraph so its HTML stays within the ${MAX_HTML_BYTES} bytes the canvas keeps`, () => {
        const paragraph = para('x'.repeat(1000));
        const html = textOf(paragraph.repeat(100))?.html ?? '';
        expect(Buffer.byteLength(html)).toBeLessThanOrEqual(MAX_HTML_BYTES);
        expect(html.endsWith('</p>')).toBe(true);
        expect(html.split('<p>')).toHaveLength(Math.floor(MAX_HTML_BYTES / 1007) + 1);
    });

    test('keeps the start of a first paragraph too long to fit, never cutting an entity, a tag or a character', () => {
        const fits = (html: string | undefined) => Buffer.byteLength(html ?? '') <= MAX_HTML_BYTES;
        const plain = textOf(para('x'.repeat(70_000)))?.html;
        expect(fits(plain)).toBe(true);
        expect(plain).toMatch(/^<p>x{60000,}<\/p>$/);
        const escaped = textOf(para('&amp;'.repeat(20_000)))?.html;
        expect(fits(escaped)).toBe(true);
        expect(escaped).toMatch(/^<p>(&amp;){10000,}<\/p>$/);
        const broken = textOf(`<a:p>${`${run('ab')}<a:br/>`.repeat(20_000)}</a:p>`)?.html;
        expect(fits(broken)).toBe(true);
        expect(broken).toMatch(/^<p>(ab<br>)+(ab?)?<\/p>$/);
        const wide = textOf(para('😀'.repeat(20_000)))?.html;
        expect(fits(wide)).toBe(true);
        expect(wide).toMatch(/^<p>(😀)+<\/p>$/u);
    });

    test('cut inside a list, still closes every list it opened', () => {
        const listStyle = level(1, '', '<a:buChar char="•"/>') + level(2, '', '<a:buAutoNum type="arabicPeriod"/>');
        const paragraphs = Array.from({ length: 100 }, (_, i) => bulleted('x'.repeat(1000), i % 2)).join('');
        const html = textOf(paragraphs, { listStyle })?.html ?? '';
        expect(Buffer.byteLength(html)).toBeLessThanOrEqual(MAX_HTML_BYTES);
        expect(html.startsWith('<ul><li><p>x')).toBe(true);
        expect(html.endsWith('</li></ul>')).toBe(true);
        const opened = (tag: string) => html.split(`<${tag}>`).length;
        const closed = (tag: string) => html.split(`</${tag}>`).length;
        for (const tag of ['ul', 'ol', 'li', 'p']) expect(opened(tag)).toBe(closed(tag));
    });

    test('leaves out the paragraph whose closing tags would cross the cap', () => {
        const listStyle = Array.from({ length: 9 }, (_, i) => level(i + 1, '', '<a:buChar char="•"/>')).join('');
        // Nine lists opened, 16 bytes each, then an item of 16 bytes and its text, 50 bytes short of the cap: its
        // nine closing </li></ul> would take 90.
        const nested = Array.from({ length: 9 }, (_, i) => bulleted('x', i)).join('');
        const html = textOf(nested + bulleted('y'.repeat(MAX_HTML_BYTES - 50 - 160), 8), { listStyle })?.html ?? '';
        expect(html).toBe(`${'<ul><li><p>x</p>'.repeat(9)}${'</li></ul>'.repeat(9)}`);
    });
});

describe('run properties', () => {
    // Nearest first: each level states a size, and the nearest one stated wins.
    test('come from the run, else the shape, layout and master list styles, else the master text styles', () => {
        const runSized = (sz?: number) => `<a:p>${run('text', sz ? ` sz="${sz}"` : '')}</a:p>`;
        const all = {
            lstStyle: sized(1600),
            inherited: [
                ['', sized(1400)],
                ['', sized(1200)],
            ] as [string, string][],
            listStyle: sized(1000),
        };
        expect(textOf(runSized(2000), all)?.fontSize).toBe(40);
        expect(textOf(runSized(), all)?.fontSize).toBe(32);
        expect(textOf(runSized(), { ...all, lstStyle: '' })?.fontSize).toBe(28);
        expect(
            textOf(runSized(), {
                ...all,
                lstStyle: '',
                inherited: [
                    ['', ''],
                    ['', sized(1200)],
                ],
            })?.fontSize,
        ).toBe(24);
        expect(textOf(runSized(), { listStyle: sized(1000) })?.fontSize).toBe(20);
        // ECMA-376's 18 pt where nothing states a size.
        expect(textOf(runSized())?.fontSize).toBe(36);
    });

    test("are read at the paragraph's level, else the list style's defPPr", () => {
        const listStyle = `<a:defPPr>${defRPr(' sz="1000"')}</a:defPPr>${level(1, '', defRPr(' sz="3000"'))}${level(3, '', defRPr(' sz="2000"'))}`;
        expect(textOf(`<a:p><a:pPr lvl="2"/>${run('third')}</a:p>`, { listStyle })?.fontSize).toBe(40);
        expect(textOf(`<a:p><a:pPr lvl="1"/>${run('second')}</a:p>`, { listStyle })?.fontSize).toBe(20);
        expect(textOf(para('first'), { listStyle })?.fontSize).toBe(60);
    });

    test("never come from the paragraph's own defRPr, which PowerPoint ignores", () => {
        const found = textOf(
            `<a:p><a:pPr>${defRPr(' sz="4000" b="1"', schemeFill('accent2'))}</a:pPr>${run('t')}</a:p>`,
            {
                listStyle: level(1, '', defRPr(' sz="1000"')),
            },
        );
        expect(found).toMatchObject({ fontSize: 20, fontWeight: 'normal', color: '#000000' });
    });

    test('take a property each from wherever it is stated nearest', () => {
        const found = textOf(para('text', ' b="1"'), {
            lstStyle: level(1, '', defRPr(' sz="2000"')),
            listStyle: level(1, '', defRPr(' sz="1000" b="0" i="1"', schemeFill('accent2'))),
        });
        expect(found).toMatchObject({ fontSize: 40, fontWeight: 'bold', fontStyle: 'italic', color: '#c0504d' });
    });

    test("resolve the theme's fonts", () => {
        expect(textOf(para('t', '', '<a:latin typeface="+mn-lt"/>'))?.fontFamily).toBe('JetBrains Mono');
        expect(textOf(para('t', '', '<a:latin typeface="Arial"/>'))?.fontFamily).toBe('Inter');
        expect(textOf(para('t', '', '<a:latin typeface="Times New Roman"/>'))?.fontFamily).toBe('Source Serif 4');
        // An unknown font is the deck's default.
        expect(textOf(para('t', '', '<a:latin typeface="Papyrus"/>'))?.fontFamily).toBe('Inter');
    });

    // As LibreOffice draws it: a shape's own list style beats its style's fontRef, whose colour beats the master's
    // text styles and the presentation's default, whose typeface beats the fontRef's.
    test("take the shape style's fontRef colour beneath the list styles a shape states, its font beneath every one", () => {
        const style = fontRef('major', '<a:schemeClr val="accent1"/>');
        const red = level(1, '', defRPr('', `${schemeFill('accent2')}<a:latin typeface="Times New Roman"/>`));
        expect(textOf(para('t'), { style })).toMatchObject({ fontFamily: 'Source Serif 4', color: '#4f81bd' });
        expect(textOf(para('t'), { style, lstStyle: red })).toMatchObject({
            fontFamily: 'Source Serif 4',
            color: '#c0504d',
        });
        expect(textOf(para('t'), { style, inherited: [['', red]] })).toMatchObject({ color: '#c0504d' });
        const minor = level(1, '', defRPr('', `${schemeFill('accent2')}<a:latin typeface="+mn-lt"/>`));
        expect(textOf(para('t'), { style, listStyle: minor })).toMatchObject({
            fontFamily: 'JetBrains Mono',
            color: '#4f81bd',
        });
        expect(
            textOf(para('t', '', `${schemeFill('tx1')}<a:latin typeface="Arial"/>`), { style, lstStyle: red }),
        ).toMatchObject({ fontFamily: 'Inter', color: '#000000' });
        // A fontRef naming no colour leaves the colour to the list styles.
        expect(textOf(para('t'), { style: fontRef('minor'), listStyle: minor })).toMatchObject({ color: '#c0504d' });
    });

    test('a run stating no fill keeps the inherited colour', () => {
        const found = textOf(para('t', '', '<a:noFill/>'), {
            listStyle: level(1, '', defRPr('', schemeFill('accent1'))),
        });
        expect(found?.color).toBe('#4f81bd');
    });

    test('spc is letter spacing', () => {
        expect(textOf(para('spaced', ' spc="300"'))?.letterSpacing).toBe(6);
        expect(textOf(para('tight', ' spc="-150"'))?.letterSpacing).toBe(-3);
    });
});

describe('inline marks', () => {
    test('mark where a run differs from the box, adjacent runs sharing them', () => {
        const html = textOf(
            `<a:p>${run('plain text here ')}${run('bo', ' b="1"')}${run('ld', ' b="1"')}${run(' it', ' i="1"')}${run(' under', ' u="sng"')}${run(' struck', ' strike="sngStrike"')}${run(' both', ' b="1" i="1"')}</a:p>`,
        )?.html;
        expect(html).toBe(
            '<p>plain text here <strong>bold</strong><em> it</em><u> under</u><s> struck</s><strong><em> both</em></strong></p>',
        );
    });

    test('a mark the box has is no tag', () => {
        expect(textOf(para('all bold and italic', ' b="1" i="1" u="sng"'))).toMatchObject({
            fontWeight: 'bold',
            fontStyle: 'italic',
            textDecoration: 'underline',
            html: '<p>all bold and italic</p>',
        });
    });

    test("a mark is the box's only when every character has it, as no run could take it off", () => {
        const found = textOf(`<a:p>${run('Mostly bold text', ' b="1"')}${run('plain')}</a:p>`);
        expect(found).toMatchObject({ fontWeight: 'normal', html: '<p><strong>Mostly bold text</strong>plain</p>' });
        // A run of spaces has no characters to count.
        const spaced = textOf(`<a:p>${run('Bold', ' b="1"')}${run(' ')}${run('Text', ' b="1" u="sng"')}</a:p>`);
        expect(spaced).toMatchObject({
            fontWeight: 'bold',
            textDecoration: 'none',
            html: '<p>Bold <u>Text</u></p>',
        });
    });

    test('u="none" and strike="noStrike" are no marks', () => {
        expect(textOf(para('t', ' u="none" strike="noStrike"'))).toMatchObject({
            textDecoration: 'none',
            html: '<p>t</p>',
        });
        expect(textOf(para('t', ' strike="dblStrike"'))?.textDecoration).toBe('line-through');
    });

    test('a link is kept when it is an external http, https or mailto target', () => {
        const rels = new Map<string, Relationship>([
            ['rId1', { type: `${REL}/hyperlink`, target: 'https://eigen.is/?a=1&b="2"', external: true }],
            ['rId2', { type: `${REL}/hyperlink`, target: 'javascript:alert(1)', external: true }],
            ['rId3', { type: `${REL}/hyperlink`, target: 'mailto:hi@eigen.is', external: true }],
            ['rId4', { type: `${REL}/slide`, target: 'ppt/slides/slide2.xml', external: false }],
            ['rId5', { type: `${REL}/hyperlink`, target: ' javascript:alert(1)', external: true }],
            // An internal target is a part name, whatever it spells.
            ['rId6', { type: `${REL}/hyperlink`, target: 'https://eigen.is', external: false }],
        ]);
        const linked = (id: string, text: string) => run(text, '', `<a:hlinkClick r:id="${id}"/>`);
        const html = textOf(
            `<a:p>${run('see ')}${linked('rId1', 'site')}${run(', ')}${linked('rId2', 'evil')}${run(', ')}${linked('rId3', 'mail')}${linked('rId4', ' next')}${linked('rId5', ' spaced')}${linked('rId9', ' gone')}${linked('rId6', ' internal')}</a:p>`,
            { rels },
        )?.html;
        expect(html).toBe(
            '<p>see <a href="https://eigen.is/?a=1&amp;b=&quot;2&quot;">site</a>, evil, <a href="mailto:hi@eigen.is">mail</a> next spaced gone internal</p>',
        );
    });
});

describe('paragraph properties', () => {
    test('align the box as its first paragraph with text is aligned, nearest stated first', () => {
        const second = `<a:p><a:pPr algn="ctr"/>${run('second')}</a:p>`;
        expect(textOf(`<a:p><a:pPr algn="ctr"/>${run('t')}</a:p>`)?.textAlign).toBe('center');
        expect(textOf(`<a:p><a:pPr algn="just"/>${run('t')}</a:p>`)?.textAlign).toBe('justify');
        expect(textOf(`<a:p/>${para('t')}${second}`, { listStyle: level(1, ' algn="r"') })?.textAlign).toBe('right');
        expect(textOf(para('t'))?.textAlign).toBe('left');
        expect(
            textOf(para('t'), { inherited: [['', level(1, ' algn="ctr"')]], listStyle: level(1, ' algn="r"') })
                ?.textAlign,
        ).toBe('center');
    });

    test('lnSpc is the line height, single spacing being 1.2', () => {
        const spaced = (inner: string) =>
            `<a:p><a:pPr><a:lnSpc>${inner}</a:lnSpc></a:pPr>${run('t', ' sz="2400"')}</a:p>`;
        expect(textOf(spaced('<a:spcPct val="150000"/>'))?.lineHeight).toBeCloseTo(1.8, 6);
        // 36 pt lines under 24 pt text.
        expect(textOf(spaced('<a:spcPts val="3600"/>'))?.lineHeight).toBeCloseTo(1.5, 6);
        expect(
            textOf(para('t'), { listStyle: level(1, '', '<a:lnSpc><a:spcPct val="90000"/></a:lnSpc>') })?.lineHeight,
        ).toBeCloseTo(1.08, 6);
        expect(textOf(para('t'))?.lineHeight).toBeCloseTo(1.2, 6);
    });
});

describe('bullets', () => {
    const listStyle =
        level(1, '', '<a:buChar char="•"/>') +
        level(2, '', '<a:buAutoNum type="arabicPeriod"/>') +
        level(3, '', '<a:buChar char="–"/>');

    test('nest as lists by level, numbered where the level numbers', () => {
        const html = textOf(
            bulleted('one') + bulleted('one.one', 1) + bulleted('one.two', 1) + bulleted('deep', 2) + bulleted('two'),
            { listStyle },
        )?.html;
        expect(html).toBe(
            '<ul><li><p>one</p><ol><li><p>one.one</p></li><li><p>one.two</p><ul><li><p>deep</p></li></ul></li></ol></li><li><p>two</p></li></ul>',
        );
    });

    test('are inherited, stated on the paragraph, or switched off by buNone', () => {
        const html = textOf(
            bulleted('inherited') +
                bulleted('off', 0, '<a:buNone/>') +
                bulleted('numbered', 0, '<a:buAutoNum type="alphaLcParenR"/>') +
                bulleted('skips a level', 2),
            { listStyle },
        )?.html;
        expect(html).toBe(
            '<ul><li><p>inherited</p></li></ul><p>off</p><ol><li><p>numbered</p><ul><li><p>skips a level</p></li></ul></li></ol>',
        );
    });

    test('a paragraph with no bullet, or no text, is a paragraph between lists', () => {
        const html = textOf(
            `${bulleted('a')}<a:p><a:pPr lvl="0"/></a:p>${bulleted('b')}${bulleted('plain', 0, '<a:buNone/>')}`,
            { listStyle },
        )?.html;
        expect(html).toBe('<ul><li><p>a</p></li></ul><p></p><ul><li><p>b</p></li></ul><p>plain</p>');
        expect(textOf(para('no list style'))?.html).toBe('<p>no list style</p>');
    });
});

describe('the body', () => {
    test('anchors the box and insets its text, inherited from the placeholders', () => {
        expect(textOf(para('t'), { bodyPr: ' anchor="ctr"' })?.verticalAlign).toBe('center');
        expect(textOf(para('t'), { inherited: [[' anchor="b"', '']] })?.verticalAlign).toBe('bottom');
        expect(textOf(para('t'))?.verticalAlign).toBe('top');
        // 0.1 inch each side by default: 91,440 EMU.
        expect(textOf(para('t'))?.padding).toBeCloseTo(14.4, 6);
        expect(textOf(para('t'), { bodyPr: ' lIns="0" rIns="127000"' })?.padding).toBeCloseTo(10, 6);
        expect(textOf(para('t'), { inherited: [[' lIns="0" rIns="0"', '']] })?.padding).toBe(0);
        // Strict writes a universal measure: 10 pt and 0.5 cm.
        expect(textOf(para('t'), { bodyPr: ' lIns="10pt" rIns="0.5cm"' })?.padding).toBeCloseTo(
            (20 + 3600 / 127) / 2,
            6,
        );
    });

    test("normAutofit's fontScale shrinks the text and lnSpcReduction its lines", () => {
        const autofit = '<a:normAutofit fontScale="50000" lnSpcReduction="20000"/>';
        const body = (bodyPr: string) =>
            parse(`<p:txBody ${NS}><a:bodyPr>${bodyPr}</a:bodyPr><a:lstStyle/>${para('t', ' sz="2400"')}</p:txBody>`);
        const found = richTextOf(
            { body: body(autofit), inherited: [], listStyle: undefined, style: undefined, rels: new Map() },
            THEME,
            WIDE_DECK,
            UNCOUNTED,
        );
        expect(found?.fontSize).toBe(24);
        expect(found?.lineHeight).toBeCloseTo(0.96, 6);
        // The layout's autofit applies where the slide's body states none.
        const inherited = richTextOf(
            {
                body: body(''),
                inherited: [inheritedOf(body(autofit))],
                listStyle: undefined,
                style: undefined,
                rels: new Map(),
            },
            THEME,
            WIDE_DECK,
            UNCOUNTED,
        );
        expect(inherited?.fontSize).toBe(24);
        const own = richTextOf(
            {
                body: body('<a:noAutofit/>'),
                inherited: [inheritedOf(body(autofit))],
                listStyle: undefined,
                style: undefined,
                rels: new Map(),
            },
            THEME,
            WIDE_DECK,
            UNCOUNTED,
        );
        expect(own?.fontSize).toBe(48);
    });
});

describe('a placeholder on a slide', () => {
    test("takes the master's body style, its layout's list style and the slide's links", () => {
        const txStyles = `<p:txStyles><p:titleStyle>${level(1, ' algn="ctr"', defRPr(' sz="4400"', '<a:latin typeface="+mj-lt"/>'))}</p:titleStyle><p:bodyStyle>${level(1, '', `<a:buChar char="•"/>${defRPr(' sz="2800"', `${schemeFill('tx1')}<a:latin typeface="+mn-lt"/>`)}`)}${level(2, '', `<a:buChar char="–"/>${defRPr(' sz="2400"')}`)}</p:bodyStyle><p:otherStyle/></p:txStyles>`;
        const deck = readPptx(
            buildPptx({
                masters: [
                    {
                        txStyles,
                        shapes:
                            sp({ ph: '<p:ph type="title"/>', xfrm: box(0, 0, 1000, 100), text: '<a:p/>' }) +
                            sp({ ph: '<p:ph type="body" idx="1"/>', xfrm: box(0, 200, 1000, 600), text: '<a:p/>' }),
                    },
                ],
                layouts: [
                    {
                        shapes: sp({
                            ph: '<p:ph idx="1"/>',
                            lstStyle: level(1, '', defRPr(' sz="2000"')),
                            text: '<a:p/>',
                        }),
                    },
                ],
                slides: [
                    {
                        shapes:
                            sp({ ph: '<p:ph type="title"/>', text: para('Title') }) +
                            sp({
                                ph: '<p:ph idx="1"/>',
                                text: `<a:p>${run('Read ')}${run('this', '', '<a:hlinkClick r:id="rId2"/>')}</a:p>${bulleted('nested', 1)}`,
                            }),
                        rels: rel('rId2', 'hyperlink', 'https://eigen.is', true),
                    },
                ],
            }),
            { maxMediaBytes: 1024 },
        );
        const [title, body] = deck.slides[0].elements;
        expect(title).toMatchObject({
            html: '<p>Title</p>',
            fontSize: 88,
            fontFamily: 'Source Serif 4',
            textAlign: 'center',
        });
        expect(body).toMatchObject({
            html: '<ul><li><p>Read <a href="https://eigen.is">this</a></p><ul><li><p>nested</p></li></ul></li></ul>',
            fontSize: 40,
            fontFamily: 'JetBrains Mono',
            color: '#000000',
        });
    });
});

describe('a text style every paragraph inherits', () => {
    test('is looked into once, its levels, run defaults and their fill too, however many paragraphs and runs take it', () => {
        const junk = '<a:x/>'.repeat(100);
        const listStyle = parse(
            `<p:bodyStyle ${NS}>${junk}${level(1, '', `${junk}<a:buChar char="•"/>${defRPr(' sz="1000"', `${junk}<a:solidFill>${junk}<a:schemeClr val="accent2"/></a:solidFill>`)}`)}</p:bodyStyle>`,
        );
        const lvl1pPr = xmlChild(listStyle, A_NS, 'lvl1pPr');
        const defaults = lvl1pPr && xmlChild(lvl1pPr, A_NS, 'defRPr');
        const fill = defaults && xmlChild(defaults, A_NS, 'solidFill');
        if (!lvl1pPr || !defaults || !fill) throw new Error('no level');
        const counts = [listStyle, lvl1pPr, defaults, fill].map(countVisits);
        const found = richTextOf(
            { body: txBody(para('x').repeat(1000)), inherited: [], listStyle, style: undefined, rels: new Map() },
            THEME,
            WIDE_DECK,
            UNCOUNTED,
        );
        expect(found).toMatchObject({ fontSize: 20, color: '#c0504d', html: expect.stringContaining('<ul><li>') });
        // A scan is about 102 reads; each paragraph and run scanning again was 1,000 of them.
        for (const count of counts) expect(count.visits).toBeLessThan(500);
    });
});
