import { describe, expect, test } from 'bun:test';
import { type XmlElement, xmlElements } from '../../lib/core/xml';
import { A_NS, DSP_NS, emu, P_NS, parseOoxml, R_NS, W_NS, XDR_NS } from '../../lib/ooxml/ooxml';

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

    test("a Strict worksheet's drawing reads in SpreadsheetDrawing and DrawingML", () => {
        const root = read(
            `<xdr:wsDr xmlns:xdr="${STRICT}/drawingml/spreadsheetDrawing" xmlns:a="${STRICT}/drawingml/main"><xdr:absoluteAnchor><a:off/></xdr:absoluteAnchor></xdr:wsDr>`,
        );
        expect(namespaces(root)).toEqual([XDR_NS, XDR_NS, A_NS]);
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

describe('a coordinate', () => {
    test('is EMU, or a universal measure in EMU', () => {
        expect([emu('914400'), emu(' -12 '), emu('1in'), emu('2.5pt'), emu('1.5')]).toEqual([
            914400, -12, 914400, 31750, 1.5,
        ]);
    });

    test('is none past what a double holds exactly, in no unit, or not a number', () => {
        for (const value of [undefined, '', '9007199254740992', '1em', '1e3', 'NaN', '- 1', '1.'])
            expect([value, emu(value)]).toEqual([value, undefined]);
    });

    test('is none past 64 characters, before it is parsed: no coordinate needs more', () => {
        expect(emu(`${'0'.repeat(63)}5`)).toBe(5);
        expect(emu(`${'0'.repeat(64)}5`)).toBeUndefined();
        expect(emu(`5.${'0'.repeat(4_000_000)}`)).toBeUndefined();
    });
});
