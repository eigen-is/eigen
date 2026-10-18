import { describe, expect, test } from 'bun:test';
import { A_NS, DSP_NS, P_NS, parseOoxml, R_NS, W_NS } from '../../lib/core/ooxml';
import { type XmlElement, xmlElements } from '../../lib/core/xml';

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

    test('a Strict presentation reads in PresentationML and DrawingML', () => {
        const root = read(
            `<p:sld xmlns:p="${STRICT}/presentationml/main" xmlns:a="${STRICT}/drawingml/main"><p:cSld><a:off/></p:cSld></p:sld>`,
        );
        expect(namespaces(root)).toEqual([P_NS, P_NS, A_NS]);
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
