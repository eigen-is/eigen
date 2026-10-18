import { describe, expect, test } from 'bun:test';
import { getSchema, type JSONContent } from '@tiptap/core';
import { Node } from '@tiptap/pm/model';
import { writeMathml } from '@workspace/math';
import * as Y from 'yjs';
import { restoreYjsDoc } from '../../../core/collab/yjs-utils';
import {
    BAND_EXCLUDED_NODES,
    BAND_ROOTS,
    bandEdge,
    bandHasContent,
    FIRST_PAGE_BAND,
    getDocExtensions,
} from '../../../docs/eigendoc';
import { EIGEN_DOC_TYPE_INFO } from '../../../types/drive';
import { installHappyDom } from '../../happy-dom';

// An equation reads its stored MathML with DOMParser.
installHappyDom();

const schema = getSchema(getDocExtensions());

describe('the header and footer bands', () => {
    test('page 1 takes the first-page band of its edge, and each band sits at the header or the footer edge', () => {
        expect(FIRST_PAGE_BAND).toEqual({ header: 'headerFirst', footer: 'footerFirst' });
        expect(BAND_ROOTS.map(bandEdge)).toEqual(['header', 'footer', 'header', 'footer']);
    });

    test('are four XmlFragment roots of the doc, so a version restore takes them with it', () => {
        expect([...BAND_ROOTS]).toEqual(['header', 'footer', 'headerFirst', 'footerFirst']);
        expect(EIGEN_DOC_TYPE_INFO.doc.yjsRoots).toMatchObject({
            header: 'xmlfragment',
            footer: 'xmlfragment',
            headerFirst: 'xmlfragment',
            footerFirst: 'xmlfragment',
        });

        const old = new Y.Doc();
        old.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
        const live = new Y.Doc();
        Y.applyUpdate(live, Y.encodeStateAsUpdate(old));
        for (const root of BAND_ROOTS) live.getXmlFragment(root).insert(0, [new Y.XmlElement('paragraph')]);

        restoreYjsDoc(live, Y.encodeStateAsUpdate(old), EIGEN_DOC_TYPE_INFO.doc.yjsRoots);
        for (const root of BAND_ROOTS) expect(live.getXmlFragment(root).length).toBe(0);
    });

    // A mark missing from a band's schema would delete the text that carries it, so only nodes are left out.
    test("a band's schema leaves out the excluded nodes and keeps every mark", () => {
        const band = getSchema(getDocExtensions({ exclude: [...BAND_EXCLUDED_NODES] }));
        expect([...BAND_EXCLUDED_NODES].sort()).toEqual(['chart', 'codeBlock', 'pageBreak', 'subtitle', 'title']);
        // The code block exists only with lowlight, so the band leaves it out of the schema that has one.
        const withCode = getSchema(getDocExtensions({ lowlight: {}, exclude: [...BAND_EXCLUDED_NODES] }));
        for (const name of BAND_EXCLUDED_NODES) {
            expect(band.nodes[name]).toBeUndefined();
            expect(withCode.nodes[name]).toBeUndefined();
        }
        expect(Object.keys(band.marks)).toEqual(Object.keys(schema.marks));
        expect(band.nodes['figure']).toBeDefined();
        expect(band.nodes['pageNumber']).toBeDefined();
        // Word allows its math in a header and a footer.
        expect(band.nodes['equation']).toBeDefined();
    });

    describe('bandHasContent', () => {
        const band = (...content: JSONContent[]) => Node.fromJSON(schema, { type: 'doc', content });
        const paragraph = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });

        // Focusing a band and leaving it leaves an empty paragraph, which prints as nothing.
        test('is false for no blocks, empty paragraphs, whitespace and line breaks', () => {
            expect(bandHasContent(band(paragraph()))).toBe(false);
            expect(bandHasContent(band(paragraph(), paragraph()))).toBe(false);
            expect(bandHasContent(band(paragraph({ type: 'hardBreak' }, { type: 'text', text: ' ' })))).toBe(false);
            expect(bandHasContent(band(paragraph({ type: 'text', text: '  \t ' })))).toBe(false);
        });

        // An empty equation draws as an empty box in the editor and prints as nothing.
        test('is false for an empty equation, true for one with content', () => {
            const equation = (mathml: string): JSONContent => ({ type: 'equation', attrs: { mathml } });
            expect(bandHasContent(band(paragraph(equation(''))))).toBe(false);
            expect(bandHasContent(band(paragraph(equation(writeMathml([])))))).toBe(false);
            expect(bandHasContent(band(paragraph(equation(writeMathml([{ kind: 'identifier', text: 'x' }])))))).toBe(
                true,
            );
        });

        test('is true for text, an image or a page number', () => {
            expect(bandHasContent(band(paragraph(), paragraph({ type: 'text', text: 'Acme' })))).toBe(true);
            expect(bandHasContent(band(paragraph({ type: 'figure', attrs: { mediaName: 'logo.png' } })))).toBe(true);
            expect(bandHasContent(band(paragraph({ type: 'pageNumber', attrs: { kind: 'page' } })))).toBe(true);
        });
    });
});
