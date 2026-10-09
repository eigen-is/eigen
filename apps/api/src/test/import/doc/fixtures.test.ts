import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { JSONContent } from '@tiptap/core';
import { docxToPmJson } from '../../../lib/import/doc/from-docx';
import { nodesOfType } from '../../fixtures/golden-docx';

// Real files from Word, LibreOffice, docx4j and GOV.UK (fixtures/docx/SOURCES.md): what each is there to show.

async function imported(name: string) {
    const bytes = await Bun.file(join(import.meta.dir, '../../fixtures/docx', name)).arrayBuffer();
    return docxToPmJson(Buffer.from(bytes));
}

const texts = (json: JSONContent) => nodesOfType(json, 'text').map((node) => node.text ?? '');
const blockTypes = (json: JSONContent) => (json.content ?? []).map((node) => node.type);

describe('docx fixtures', () => {
    test('every one imports with no block flattened', async () => {
        const names = [
            'docx4j-loadAndSave.docx',
            'govuk-Application_for_Approval_as_a_Community_Sponsor.docx',
            'lo-ooxmlexport-tdf126287.docx',
            'lo-ooxmlimport-tdf136952_pgBreak3.docx',
            'mammoth-text-box.docx',
            'poi-Numbering.docx',
            'poi-delins.docx',
            'poi-rtl.docx',
            'google-docs-all-features.docx',
        ];
        for (const name of names) expect([name, (await imported(name)).warnings]).toEqual([name, []]);
    });

    test('LibreOffice page breaks: five breaks between six text paragraphs, no blank page', async () => {
        const { json } = await imported('lo-ooxmlimport-tdf136952_pgBreak3.docx');
        expect(blockTypes(json).filter((type) => type === 'pageBreak')).toHaveLength(5);
        expect(nodesOfType(json, 'paragraph').every((node) => (node.content ?? []).length > 0)).toBe(true);
    });

    // A blank line after a break stays: only a run that ends at one goes.
    test('LibreOffice address page: the blank lines after its page break stay', async () => {
        const { json } = await imported('lo-ooxmlexport-tdf126287.docx');
        const types = blockTypes(json);
        const breakAt = types.indexOf('pageBreak');
        expect(types.slice(breakAt + 1, breakAt + 4)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    });

    test('POI right-to-left: w:jc start in a w:bidi paragraph is right-aligned (P14)', async () => {
        const { json } = await imported('poi-rtl.docx');
        const aligns = nodesOfType(json, 'paragraph').map((node) => node.attrs?.['textAlign']);
        expect(new Set(aligns)).toEqual(new Set(['right']));
    });

    test('POI tracked changes: insertions are read, deletions are not', async () => {
        const words = texts((await imported('poi-delins.docx')).json).join(' ');
        expect(words).toContain('Apache Tika 0.3 has been released');
        expect(words).not.toContain('Maang Tika');
    });

    test('POI numbering: bullets and numbers four and three levels deep, letters and roman numerals by level', async () => {
        const { json } = await imported('poi-Numbering.docx');
        const [bullets, numbers] = json.content ?? [];
        expect(nodesOfType(bullets ?? {}, 'bulletList')).toHaveLength(4);
        expect(nodesOfType(numbers ?? {}, 'orderedList').map((list) => list.attrs?.['type'])).toEqual([null, 'a', 'i']);
    });

    test("mammoth's text box: its text follows the paragraph that anchors it", async () => {
        expect(texts((await imported('mammoth-text-box.docx')).json)).toEqual(['Datum plane']);
    });

    test('GOV.UK form: its title heading and its required-documents list', async () => {
        const { json } = await imported('govuk-Application_for_Approval_as_a_Community_Sponsor.docx');
        expect(nodesOfType(json, 'heading')[0]?.content?.[0]?.text).toBe(
            'Application for Approval as a Community Sponsor',
        );
        expect(nodesOfType(json, 'bulletList')[0]?.content).toHaveLength(9);
    });

    test('docx4j load-and-save: notes, a table, the SVG as itself and majorBidi as the Arabic face', async () => {
        const { json, images } = await imported('docx4j-loadAndSave.docx');
        expect(texts(json)).toContain('[1]');
        // G11: majorBidi with an empty a:cs is the theme's Arab face, Times New Roman, as the default bidi language is ar-SA.
        const fonts = nodesOfType(json, 'text')
            .filter((node) => node.text === 'Font (Times New Roman)')
            .map((node) => node.marks?.find((mark) => mark.type === 'textStyle')?.attrs?.['fontFamily']);
        expect(fonts).toEqual(['Source Serif 4']);
        expect(nodesOfType(json, 'table').length).toBeGreaterThan(0);
        expect(images.map((image) => image.contentType)).toContain('image/svg+xml');
    });
});
