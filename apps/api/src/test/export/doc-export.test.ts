import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import JSZip from 'jszip';
import * as Y from 'yjs';
import { renderEigendocExport } from '../../lib/export/doc/transform';
import { docxToPmJson } from '../../lib/import/doc/from-docx';
import { seedEigendoc } from '../fixtures/golden-documents';

function seededDoc(json: JSONContent = { type: 'doc', content: [paragraph('Hello')] }): Y.Doc {
    const doc = new Y.Doc();
    seedEigendoc(doc, json);
    return doc;
}

function paragraph(text: string): JSONContent {
    return { type: 'paragraph', content: [{ type: 'text', text }] };
}

const brokenDoc = (): Y.Doc =>
    seededDoc({ type: 'doc', content: [paragraph('Before'), { type: 'pageBreak' }, paragraph('After')] });

async function docxDocumentXml(doc: Y.Doc): Promise<string | undefined> {
    const { data } = await renderEigendocExport(doc, 'docx', 'Report.eigendoc', []);
    return (await JSZip.loadAsync(data)).file('word/document.xml')?.async('string');
}

async function exportStyle(format: 'html' | 'pdf-html'): Promise<string> {
    const { data } = await renderEigendocExport(seededDoc(), format, 'Report.eigendoc', []);
    return new TextDecoder().decode(data).match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
}

describe('doc export — the page', () => {
    test.each(['html', 'pdf-html'] as const)('%s draws the docs page and prints on it', async (format) => {
        const css = await exportStyle(format);

        expect(css).toContain('@page { size: 210mm 297mm; margin: 20mm 20mm 20mm 20mm; }');
        // The first .page rule is the screen page; the print one under it leaves the margins and width to @page.
        const pageRule = css.match(/\.page \{([^}]*)\}/)?.[1];
        expect(pageRule).toContain('width: 210mm;');
        expect(pageRule).toContain('padding: 20mm 20mm 20mm 20mm;');
    });

    test('docx is an A4 page with 2 cm margins', async () => {
        const xml = await docxDocumentXml(seededDoc());

        const pgSz = xml?.match(/<w:pgSz\b[^>]*>/)?.[0];
        expect(pgSz).toContain('w:w="11906"');
        expect(pgSz).toContain('w:h="16838"');
        const pgMar = xml?.match(/<w:pgMar\b[^>]*>/)?.[0];
        for (const side of ['top', 'right', 'bottom', 'left']) expect(pgMar).toContain(`w:${side}="1134"`);
    });
});

describe('doc export — the stylesheet', () => {
    test('no CSS variable survives into the export', async () => {
        expect(await exportStyle('pdf-html')).not.toContain('var(');
    });

    test('headings print at medium and bold at 600', async () => {
        const css = await exportStyle('pdf-html');
        expect(css).toMatch(/h6 \{[^}]*font-weight: 500;/);
        expect(css).toMatch(/\.eigen-prose th \{[^}]*font-weight: 500;/);
        expect(css).toMatch(/strong \{ font-weight: 600; \}/);
    });
});

describe('doc export — page breaks', () => {
    test.each(['html', 'pdf-html'] as const)('%s carries the page break div', async (format) => {
        const { data } = await renderEigendocExport(brokenDoc(), format, 'Report.eigendoc', []);
        expect(new TextDecoder().decode(data)).toContain(
            '<p>Before</p><div class="page-break" data-type="page-break"></div><p>After</p>',
        );
    });

    test('docx writes a top-level page break as a Word page break', async () => {
        expect(await docxDocumentXml(brokenDoc())).toContain('<w:br w:type="page"/>');
    });

    // html-to-docx only turns a top-level page-break div into a break; the phase 1 docx writer
    // (PROPOSAL_DOCX.md) replaces it and should carry this one too.
    test('docx drops a page break nested in a list item', async () => {
        const nested = seededDoc({
            type: 'doc',
            content: [
                {
                    type: 'bulletList',
                    content: [{ type: 'listItem', content: [paragraph('Before'), { type: 'pageBreak' }] }],
                },
            ],
        });
        expect(await docxDocumentXml(nested)).not.toContain('w:type="page"');
    });

    test('a docx export imports back to the same blocks', async () => {
        const { data } = await renderEigendocExport(brokenDoc(), 'docx', 'Report.eigendoc', []);
        const { json } = await docxToPmJson(Buffer.from(data));
        expect(json.content?.map((node) => node.type)).toEqual(['paragraph', 'pageBreak', 'paragraph']);
    });
});
