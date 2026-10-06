import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import * as Y from 'yjs';
import { renderEigendocExport } from '../../lib/export/doc/transform';
import { seedEigendoc } from '../fixtures/golden-documents';

function seededDoc(): Y.Doc {
    const doc = new Y.Doc();
    seedEigendoc(doc, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] });
    return doc;
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
        const { data } = await renderEigendocExport(seededDoc(), 'docx', 'Report.eigendoc', []);
        const xml = await (await JSZip.loadAsync(data)).file('word/document.xml')?.async('string');

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
