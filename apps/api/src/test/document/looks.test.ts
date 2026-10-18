import { describe, expect, test } from 'bun:test';
import {
    DOCUMENT_FONT,
    DOCUMENT_FONT_SIZE,
    DOCUMENT_LINE_RATIO,
    SMALL_FONT_SIZE,
} from '@workspace/lib/constants/fonts';
import {
    DEFAULT_NORMAL_STYLE,
    DEFAULT_PAGE_SETUP,
    DOCUMENT_PARAGRAPH_FORMAT,
    ITALIC_HEADING_LEVELS,
    normalStyleProperties,
} from '@workspace/lib/docs/eigendoc';
import { W_NS } from '../../lib/core/ooxml';
import { parseXml, type XmlElement, xmlAttr, xmlChild, xmlChildren, xmlElements } from '../../lib/core/xml';
import { openZip } from '../../lib/core/zip';
import {
    BODY,
    CAPTION_LOOK,
    CODE_BLOCK_LOOK,
    CODE_LOOK,
    cssPt,
    HEADER_CELL_LOOK,
    HEADING_LOOKS,
    halfPoints,
    LINK_LOOK,
    nodeLook,
    QUOTE_LOOK,
    SMALL_LOOK,
    TASK_DONE_LOOK,
    TITLE_LOOKS,
} from '../../lib/document/looks';
import { PROSE_CSS, proseValue } from '../../lib/document/prose-css';
import { codeBlockStyle, headingStyleName, STYLE_NAMES } from '../../lib/document/wordml';
import { eigendocToDocx } from '../../lib/export/doc/to-docx';
import { fontLineHeight } from '../../lib/export/fonts';
import { buildAllFeaturesDocJson, buildAllFeaturesDocMedia } from '../fixtures/golden-documents';

const zip = openZip(
    await eigendocToDocx(
        buildAllFeaturesDocJson(),
        DEFAULT_PAGE_SETUP,
        DEFAULT_NORMAL_STYLE,
        buildAllFeaturesDocMedia(),
        'Report.eigendoc',
        undefined,
    ),
);

function part(path: string): XmlElement {
    const data = zip.read(path);
    const root = data === undefined ? null : parseXml(new TextDecoder().decode(data));
    if (!root) throw new Error(`${path} missing or blank`);
    return root;
}

const styles = new Map(
    xmlChildren(part('word/styles.xml'), W_NS, 'style').map((style) => [w(style, 'styleId'), style]),
);

function w(element: XmlElement | undefined, local: string): string | undefined {
    return element && xmlAttr(element, W_NS, local);
}

// A property of a style's pPr or rPr, by its path of w: children.
function prop(styleId: string, ...path: string[]): XmlElement | undefined {
    let element = styles.get(styleId);
    for (const local of path) element = element && xmlChild(element, W_NS, local);
    return element;
}

function descendants(root: XmlElement, local: string): XmlElement[] {
    return xmlElements(root).flatMap((element) => [
        ...(element.ns === W_NS && element.local === local ? [element] : []),
        ...descendants(element, local),
    ]);
}

describe('the writer names its styles by the vocabulary', () => {
    test('every style the writer defines carries its vocabulary name', () => {
        const names = new Map<string, string>(Object.entries(STYLE_NAMES));
        for (const level of [1, 2, 3, 4, 5, 6]) names.set(`Heading${level}`, headingStyleName(level));
        // The languages of the doc's code blocks.
        for (const language of ['javascript', 'plaintext']) {
            const { id, name } = codeBlockStyle(language);
            names.set(id, name);
        }
        const written = [...styles].map(([id, style]) => [id, w(xmlChild(style, W_NS, 'name'), 'val')]);
        expect(written).toEqual(written.map(([id]) => [id, id === undefined ? undefined : names.get(id)]));
        expect(new Set(written.map(([id]) => id))).toEqual(new Set(names.keys()));
    });
});

describe('the writer draws the editor look from the vocabulary', () => {
    test('a quote: its bar, indent, italic and color', () => {
        const bar = prop('Quote', 'pPr', 'pBdr', 'left');
        expect([w(bar, 'sz'), w(bar, 'space'), w(bar, 'color')]).toEqual([
            String(QUOTE_LOOK.border.sz),
            String(QUOTE_LOOK.border.space),
            QUOTE_LOOK.border.color,
        ]);
        expect(w(prop('Quote', 'pPr', 'ind'), 'left')).toBe(String(QUOTE_LOOK.indent));
        expect(prop('Quote', 'rPr', 'i') !== undefined).toBe(QUOTE_LOOK.italic);
        expect(w(prop('Quote', 'rPr', 'color'), 'val')).toBe(QUOTE_LOOK.color);
    });

    test('a title and a subtitle: no color of their own on the title, the subtitle grey', () => {
        expect(TITLE_LOOKS).toEqual({ title: {}, subtitle: { color: '666666' } });
        expect(prop('Title', 'rPr', 'color')).toBeUndefined();
        expect(w(prop('Subtitle', 'rPr', 'color'), 'val')).toBe(TITLE_LOOKS.subtitle.color);
    });

    // The reader, the writer, the renderer and the audit all ask nodeLook, so a node's look is looked up once.
    test("a node's own look: a heading's by its level, Word's 7 to 9 as 6, a title's and a subtitle's, none for the rest", () => {
        expect([1, 5, 6, 9].map((level) => nodeLook('heading', level))).toEqual([
            {},
            { color: '666666' },
            { color: '666666', italic: true },
            { color: '666666', italic: true },
        ]);
        expect([nodeLook('title'), nodeLook('subtitle'), nodeLook('paragraph')]).toEqual([
            TITLE_LOOKS.title,
            TITLE_LOOKS.subtitle,
            {},
        ]);
    });

    test('a done task: its strike and color', () => {
        expect(prop('TaskDone', 'rPr', 'strike') !== undefined).toBe(TASK_DONE_LOOK.strike);
        expect(w(prop('TaskDone', 'rPr', 'color'), 'val')).toBe(TASK_DONE_LOOK.color);
    });

    test('inline code: its font, color, size and shading', () => {
        expect(w(prop('Code', 'rPr', 'rFonts'), 'ascii')).toBe(CODE_LOOK.font);
        expect(w(prop('Code', 'rPr', 'color'), 'val')).toBe(CODE_LOOK.color);
        expect(w(prop('Code', 'rPr', 'sz'), 'val')).toBe(String(halfPoints(CODE_LOOK.sizePt)));
        expect(w(prop('Code', 'rPr', 'shd'), 'fill')).toBe(CODE_LOOK.shading);
    });

    test('a code block: its fill', () => {
        expect(w(prop('CodeBlock', 'pPr', 'shd'), 'fill')).toBe(CODE_BLOCK_LOOK.fill);
    });

    test('a caption: its size and color', () => {
        expect(w(prop('Caption', 'rPr', 'sz'), 'val')).toBe(String(halfPoints(CAPTION_LOOK.sizePt)));
        expect(w(prop('Caption', 'rPr', 'color'), 'val')).toBe(CAPTION_LOOK.color);
    });

    test('a link: its color', () => {
        expect(w(prop('Hyperlink', 'rPr', 'color'), 'val')).toBe(LINK_LOOK.color);
    });

    test('a header cell: its fill', () => {
        const fills = descendants(part('word/document.xml'), 'tcPr').map((tcPr) =>
            w(xmlChild(tcPr, W_NS, 'shd'), 'fill'),
        );
        expect(fills).toContain(HEADER_CELL_LOOK.fill);
        expect(new Set(fills.filter((fill) => fill !== undefined))).toEqual(new Set([HEADER_CELL_LOOK.fill]));
    });
});

describe('the writer draws its body in the document font', () => {
    test('the prose body is the font a doc draws without a mark', () => {
        expect(BODY.font).toBe(DOCUMENT_FONT);
    });

    // The toolbar shows them where no size is set, and a paste drops the body's.
    test('the prose body and Small are the sizes a doc draws without a size mark', () => {
        expect(BODY.sizePt).toBe(DOCUMENT_FONT_SIZE);
        expect(SMALL_LOOK.sizePt).toBe(SMALL_FONT_SIZE);
    });
});

// A paragraph's CSS line-height is its line spacing times the document font's line, which lib can't measure.
describe("the writer draws a paragraph in Eigen's declared look", () => {
    test("the document font's line ratio is Inter's, measured from its TTF", () => {
        expect(DOCUMENT_LINE_RATIO).toBe(Math.round(fontLineHeight(DOCUMENT_FONT) * 100) / 100);
    });

    test('eigen-prose.css draws an unset paragraph at line spacing 1.4 and 11 pt after', () => {
        const { lineSpacing, spaceAfter } = DOCUMENT_PARAGRAPH_FORMAT;
        expect(Number(proseValue('.eigen-prose p', 'line-height'))).toBe(
            Math.round(lineSpacing * DOCUMENT_LINE_RATIO * 10_000) / 10_000,
        );
        expect(cssPt(proseValue('.eigen-prose p', 'margin-bottom'), BODY.sizePt)).toBe(spaceAfter);
    });

    test("the default Normal is eigen-prose.css's body, and every property a doc's own sets is one the sheet reads", () => {
        expect(DEFAULT_NORMAL_STYLE).toEqual({
            font: BODY.font,
            size: BODY.sizePt,
            lineSpacing: DOCUMENT_PARAGRAPH_FORMAT.lineSpacing,
            spaceBefore: cssPt(proseValue('.eigen-prose p', 'padding-top'), BODY.sizePt),
            spaceAfter: DOCUMENT_PARAGRAPH_FORMAT.spaceAfter,
            color: `#${BODY.color.toLowerCase()}`,
        });
        const own = normalStyleProperties({
            font: 'Source Serif 4',
            size: 12,
            lineSpacing: 1,
            spaceBefore: 6,
            spaceAfter: 0,
            color: '#000000',
        });
        expect(Object.keys(own)).toHaveLength(Object.keys(DEFAULT_NORMAL_STYLE).length);
        for (const property of Object.keys(own)) expect(PROSE_CSS).toContain(`var(${property},`);
    });

    test("Word's Normal is that look: an auto line of 1.4 and 11 pt after", () => {
        const spacing = prop('Normal', 'pPr', 'spacing');
        expect([w(spacing, 'line'), w(spacing, 'lineRule'), w(spacing, 'after')]).toEqual([
            String(Math.round(240 * DOCUMENT_PARAGRAPH_FORMAT.lineSpacing)),
            'auto',
            String(DOCUMENT_PARAGRAPH_FORMAT.spaceAfter * 20),
        ]);
    });
});

// The docs app reads which headings draw italic from lib, as a paste and a copy turn an italic mark upright in them.
test("lib's italic heading levels are those eigen-prose.css sets in italic", () => {
    const italic = HEADING_LOOKS.flatMap((look, index) => (look.italic ? [index + 1] : []));
    expect(new Set(italic)).toEqual(new Set(ITALIC_HEADING_LEVELS));
});
