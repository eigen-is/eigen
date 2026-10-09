import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Editor, type JSONContent } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import * as Y from 'yjs';
import { lowlight } from '../../../lib/document/lowlight';
import { importDocxToEigendocUpdate } from '../../../lib/import/doc/transform';
import { buildDocxWithBody, nodesOfType } from '../../fixtures/golden-docx';

// An imported doc is stored as the editor leaves it on open: a first open that pads a table or appends a paragraph
// writes Yjs updates nobody typed, and two people opening it together write them twice.

const editor = new Editor({ extensions: getDocExtensions({ lowlight }), content: { type: 'doc', content: [] } });

function stored(data: ArrayBuffer): JSONContent {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, new Uint8Array(importDocxToEigendocUpdate(data, undefined).update));
    return yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment('default'), editor.schema).toJSON();
}

// The doc after the editor's plugins have seen it arrive, as the Yjs binding's first sync hands it over.
function opened(json: JSONContent): JSONContent {
    const empty = EditorState.create({ schema: editor.schema, plugins: editor.extensionManager.plugins });
    const content = editor.schema.nodeFromJSON(json).content;
    return empty.applyTransaction(empty.tr.replaceWith(0, empty.doc.content.size, content)).state.doc.toJSON();
}

const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (inner: string, pPr = '') => `<w:p>${pPr && `<w:pPr>${pPr}</w:pPr>`}${inner}</w:p>`;
const cell = (text: string) => `<w:tc>${paragraph(run(text))}</w:tc>`;
const grid = '<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>';
const table = (rows: string[]) => `<w:tbl>${grid}${rows.map((cells) => `<w:tr>${cells}</w:tr>`).join('')}</w:tbl>`;
const bullet = (text: string) => paragraph(run(text), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');

describe('an imported doc is stored as the editor leaves it on open', () => {
    test('a row Word draws short of the grid is filled to it, with the widths its columns have', async () => {
        const json = stored(
            await buildDocxWithBody(
                `${table([cell('A') + cell('B') + cell('C'), cell('D')])}${paragraph(run('After.'))}`,
            ),
        );
        expect(nodesOfType(json, 'tableRow').map((row) => row.content?.length)).toEqual([3, 3]);
        expect(opened(json)).toEqual(json);
    });

    test('a doc ending in a list ends with an empty paragraph after it', async () => {
        const json = stored(await buildDocxWithBody(`${paragraph(run('Before.'))}${bullet('One')}${bullet('Two')}`));
        expect((json.content ?? []).map((node) => node.type)).toEqual(['paragraph', 'bulletList', 'paragraph']);
        expect(opened(json)).toEqual(json);
    });

    test('a doc ending in a table ends with an empty paragraph after it', async () => {
        const json = stored(await buildDocxWithBody(table([cell('A') + cell('B') + cell('C')])));
        expect((json.content ?? []).map((node) => node.type)).toEqual(['table', 'paragraph']);
        expect(opened(json)).toEqual(json);
    });

    test.each([
        'docx4j-loadAndSave.docx',
        'govuk-Application_for_Approval_as_a_Community_Sponsor.docx',
        'lo-ooxmlexport-tdf126287.docx',
        'lo-ooxmlimport-tdf136952_pgBreak3.docx',
        'mammoth-text-box.docx',
        'poi-Numbering.docx',
        'poi-delins.docx',
        'poi-rtl.docx',
        'google-docs-all-features.docx',
    ])('%s', async (name) => {
        const json = stored(await Bun.file(join(import.meta.dir, '../../fixtures/docx', name)).arrayBuffer());
        expect(opened(json)).toEqual(json);
    });
});
