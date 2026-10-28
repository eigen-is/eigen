import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { JSONContent } from '@tiptap/core';
import { readChartSpec } from '@workspace/lib/charts';
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
            'poi-WithGIF.docx',
            'govuk-AcuteHepB_EnhancedSurveillanceForm.docx',
            'lo-ooxmlexport-tdf104061_tableSectionColumns.docx',
        ];
        for (const name of names) {
            const { warnings } = await imported(name);
            expect([name, warnings.filter((warning) => warning.code === 'blocks-flattened')]).toEqual([name, []]);
        }
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

    // Its numbers, letters and roman numerals by level are what an untyped list draws by depth, so they store no type.
    test('POI numbering: bullets and numbers four and three levels deep, letters and roman numerals by level', async () => {
        const { json } = await imported('poi-Numbering.docx');
        const [bullets, numbers] = json.content ?? [];
        expect(nodesOfType(bullets ?? {}, 'bulletList')).toHaveLength(4);
        expect(nodesOfType(numbers ?? {}, 'orderedList').map((list) => list.attrs?.['type'])).toEqual([
            null,
            null,
            null,
        ]);
    });

    const boxesOf = (json: JSONContent) =>
        nodesOfType(json, 'textBox').map((node) => [
            node.attrs?.['layout'],
            node.attrs?.['fill'],
            node.attrs?.['outline'],
            nodesOfType(node, 'text')
                .map((text) => text.text)
                .join(''),
        ]);

    test("mammoth's text box: a box in front of the text, Word's white with a black line, holding its text", async () => {
        const { json } = await imported('mammoth-text-box.docx');
        expect(texts(json)).toEqual(['Datum plane']);
        expect(boxesOf(json)).toEqual([['front', '#ffffff', '1px solid #000000', 'Datum plane']]);
    });

    // Pictures over or under the text (J1 § 9): each a figure in front of or behind it at Word's place, one in a table
    // cell a block.
    const placesOf = (json: JSONContent) =>
        nodesOfType(json, 'figure').map((node) => [
            node.attrs?.['layout'],
            node.attrs?.['offsetX'],
            node.attrs?.['offsetY'],
            node.attrs?.['width'],
        ]);

    test('POI GIF: a picture in front of the text, at its column offset, leading its paragraph', async () => {
        const { json } = await imported('poi-WithGIF.docx');
        expect(placesOf(json)).toEqual([['front', 198, -11, 176]]);
        const holder = (json.content ?? []).find((block) => block.content?.some((node) => node.type === 'figure'));
        expect(holder?.content?.[0]?.type).toBe('figure');
    });

    test('GOV.UK surveillance form: its logo in front of the text, and its banner a filled box in front', async () => {
        const { json } = await imported('govuk-AcuteHepB_EnhancedSurveillanceForm.docx');
        expect(placesOf(json)).toEqual([['front', 0, -19, 180]]);
        expect(boxesOf(json).map(([layout, fill]) => [layout, fill])).toEqual([['front', '#00ae9e']]);
    });

    test('LibreOffice table: a picture over the text in a table cell is a block in the cell', async () => {
        const { json } = await imported('lo-ooxmlexport-tdf104061_tableSectionColumns.docx');
        const cells = nodesOfType(json, 'tableCell').flatMap((cell) => nodesOfType(cell, 'figure'));
        expect(cells.length).toBeGreaterThan(0);
        expect(placesOf(json).map(([layout, x, y]) => [layout, x, y])).toEqual(
            placesOf(json).map(() => ['block', null, null]),
        );
    });

    // Its Title is bold and purple, which Eigen's title draws neither of.
    test('GOV.UK form: its title, bold and purple, and its required-documents list', async () => {
        const { json } = await imported('govuk-Application_for_Approval_as_a_Community_Sponsor.docx');
        const [title] = nodesOfType(json, 'title');
        expect([title?.content?.[0]?.text, title?.content?.[0]?.marks?.map((mark) => mark.type)]).toEqual([
            'Application for Approval as a Community Sponsor',
            ['textStyle', 'bold'],
        ]);
        expect(nodesOfType(json, 'bulletList')[0]?.content).toHaveLength(9);
    });

    test('docx4j load-and-save: notes, a table, the SVG as itself, majorBidi as the Arabic face and its chart', async () => {
        const { json, media, warnings } = await imported('docx4j-loadAndSave.docx');
        // Its footnote and its endnote, each a note at its reference.
        expect(nodesOfType(json, 'footnote').map((note) => texts(note).join(''))).toEqual(['Footnote', 'Endnote']);
        // G11: majorBidi with an empty a:cs is the theme's Arab face, Times New Roman, as the default bidi language is ar-SA.
        const fonts = nodesOfType(json, 'text')
            .filter((node) => node.text === 'Font (Times New Roman)')
            .map((node) => node.marks?.find((mark) => mark.type === 'textStyle')?.attrs?.['fontFamily']);
        expect(fonts).toEqual(['Source Serif 4']);
        expect(nodesOfType(json, 'table').length).toBeGreaterThan(0);
        expect(media.map((image) => image.contentType)).toContain('image/svg+xml');
        // Its pie chart is a chart, and its header's text watermark goes.
        const charts = nodesOfType(json, 'chart').map((chart) => readChartSpec(chart.attrs ?? {}).spec);
        expect([charts.map((spec) => [spec?.chart.type, spec?.title.text]), warnings]).toEqual([
            [['pie', 'A Chart']],
            [{ code: 'band-content-dropped', count: 1 }],
        ]);
    });
});
