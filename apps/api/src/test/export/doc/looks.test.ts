import { describe, expect, test } from 'bun:test';
import { DOCUMENT_FONT } from '@workspace/lib/constants/fonts';
import { codeBlockStyle, headingStyleName, STYLE_NAMES, W_NS } from '../../../lib/core/ooxml';
import { parseXml, type XmlElement, xmlAttr, xmlChild, xmlChildren, xmlElements } from '../../../lib/core/xml';
import { openZip } from '../../../lib/core/zip';
import {
    BODY,
    CAPTION_LOOK,
    CODE_BLOCK_LOOK,
    CODE_LOOK,
    HEADER_CELL_LOOK,
    halfPoints,
    LINK_LOOK,
    QUOTE_LOOK,
    TASK_DONE_LOOK,
} from '../../../lib/export/doc/looks';
import { eigendocToDocx } from '../../../lib/export/doc/to-docx';
import { buildAllFeaturesDocJson, buildAllFeaturesDocMedia } from '../../fixtures/golden-documents';

const zip = openZip(
    await eigendocToDocx(buildAllFeaturesDocJson(), buildAllFeaturesDocMedia(), 'Report.eigendoc', undefined),
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
});
