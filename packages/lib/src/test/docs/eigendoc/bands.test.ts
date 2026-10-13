import { describe, expect, test } from 'bun:test';
import { getSchema, type JSONContent } from '@tiptap/core';
import { Node } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { restoreYjsDoc } from '../../../core/collab/yjs-utils';
import { BAND_EXCLUDED_NODES, BAND_ROOTS, bandHasContent, getDocExtensions } from '../../../docs/eigendoc';
import { EIGEN_DOC_TYPE_INFO } from '../../../types/drive';

const schema = getSchema(getDocExtensions());

describe('the header and footer bands', () => {
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
        expect([...BAND_EXCLUDED_NODES].sort()).toEqual(['codeBlock', 'pageBreak', 'subtitle', 'title']);
        // The code block exists only with lowlight, so the band leaves it out of the schema that has one.
        const withCode = getSchema(getDocExtensions({ lowlight: {}, exclude: [...BAND_EXCLUDED_NODES] }));
        for (const name of BAND_EXCLUDED_NODES) {
            expect(band.nodes[name]).toBeUndefined();
            expect(withCode.nodes[name]).toBeUndefined();
        }
        expect(Object.keys(band.marks)).toEqual(Object.keys(schema.marks));
        expect(band.nodes['figure']).toBeDefined();
        expect(band.nodes['pageNumber']).toBeDefined();
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

        test('is true for text, an image or a page number', () => {
            expect(bandHasContent(band(paragraph(), paragraph({ type: 'text', text: 'Acme' })))).toBe(true);
            expect(bandHasContent(band(paragraph({ type: 'figure', attrs: { mediaName: 'logo.png' } })))).toBe(true);
            expect(bandHasContent(band(paragraph({ type: 'pageNumber', attrs: { kind: 'page' } })))).toBe(true);
        });
    });
});
