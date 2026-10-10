import { describe, expect, test } from 'bun:test';
import {
    A_NS,
    codeBlockLanguage,
    codeBlockStyle,
    DSP_NS,
    headingLevel,
    headingStyleName,
    parseOoxml,
    R_NS,
    STYLE_NAMES,
    W_NS,
} from '../../lib/core/ooxml';
import { type XmlElement, xmlElements } from '../../lib/core/xml';

describe('the heading style name', () => {
    test('reads back as its level, in any case', () => {
        expect(headingLevel(headingStyleName(3))).toBe(3);
        expect(headingLevel('Heading 9')).toBe(9);
    });

    test('any other name has no level', () => {
        expect(headingLevel('heading 10')).toBeUndefined();
        expect(headingLevel('heading 0')).toBeUndefined();
        expect(headingLevel('Heading1')).toBeUndefined();
        expect(headingLevel('TOC Heading')).toBeUndefined();
    });
});

describe('the code block language carrier', () => {
    test('a language is a style of its own, named after Code Block', () => {
        expect(codeBlockStyle('javascript')).toEqual({ id: 'CodeBlock-javascript', name: 'Code Block (javascript)' });
    });

    test('its name reads back as the language, in any case', () => {
        expect(codeBlockLanguage(codeBlockStyle('javascript').name)).toBe('javascript');
        expect(codeBlockLanguage('code block (plaintext)')).toBe('plaintext');
    });

    test('any other style carries no language', () => {
        expect(codeBlockLanguage(STYLE_NAMES.CodeBlock)).toBeUndefined();
        expect(codeBlockLanguage('Code Block ()')).toBeUndefined();
        expect(codeBlockLanguage('HTML Preformatted')).toBeUndefined();
    });
});

describe('Strict OOXML read as transitional', () => {
    const STRICT = 'http://purl.oclc.org/ooxml';
    const read = (xml: string) => {
        const root = parseOoxml(xml);
        if (!root) throw new Error('no root');
        return root;
    };
    const namespaces = (root: XmlElement): string[] => [root.ns, ...xmlElements(root).flatMap(namespaces)];

    test('a Strict part reads in the transitional namespaces, its attributes too', () => {
        const root = read(
            `<w:document xmlns:w="${STRICT}/wordprocessingml/main" xmlns:r="${STRICT}/officeDocument/relationships"><w:body><w:p r:id="x"/></w:body></w:document>`,
        );
        expect(namespaces(root)).toEqual([W_NS, W_NS, W_NS]);
        expect(xmlElements(xmlElements(root)[0] ?? root)[0]?.attributeNs).toEqual({ 'r:id': R_NS });
    });

    // Word's SmartArt drawing: its root is Microsoft's, the shapes inside it Strict.
    test('a part whose root declares a Strict namespace it uses only inside reads it as transitional', () => {
        const root = read(
            `<dsp:drawing xmlns:dsp="${DSP_NS}" xmlns:a="${STRICT}/drawingml/main"><a:off/></dsp:drawing>`,
        );
        expect(namespaces(root)).toEqual([DSP_NS, A_NS]);
    });

    test('a Strict namespace declared below the root is read as transitional, its attributes too', () => {
        const root = read(
            `<w:document xmlns:w="${W_NS}"><w:body><a:off xmlns:a="${STRICT}/drawingml/main" xmlns:r="${STRICT}/officeDocument/relationships" r:id="x"/></w:body></w:document>`,
        );
        expect(namespaces(root)).toEqual([W_NS, W_NS, A_NS]);
        expect(xmlElements(xmlElements(root)[0] ?? root)[0]?.attributeNs).toEqual({ 'r:id': R_NS });
    });
});
