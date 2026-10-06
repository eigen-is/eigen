import { describe, expect, test } from 'bun:test';
import { DEFAULT_PAGE_SETUP, pageAtRule, pageBoxStyle } from '@workspace/lib/docs/eigendoc';
import JSZip from 'jszip';
import * as Y from 'yjs';
import { renderEigendocExport } from '../../lib/export/doc/transform';
import { seedEigendoc } from '../fixtures/golden-documents';

function seededDoc(): Y.Doc {
    const doc = new Y.Doc();
    seedEigendoc(doc, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] });
    return doc;
}

describe('doc export — the page', () => {
    test.each(['html', 'pdf-html'] as const)('%s draws the docs page and prints on it', async (format) => {
        const { data } = await renderEigendocExport(seededDoc(), format, 'Report.eigendoc', []);
        const html = new TextDecoder().decode(data);
        const box = pageBoxStyle(DEFAULT_PAGE_SETUP);

        expect(html).toContain(pageAtRule(DEFAULT_PAGE_SETUP));
        expect(html).not.toContain('2.5cm');
        // The first .page rule is the screen page; the print one under it drops the padding for @page's margin.
        const pageRule = html.match(/\.page \{([^}]*)\}/)?.[1];
        expect(pageRule).toContain(`width: ${box.width};`);
        expect(pageRule).toContain(`padding: ${box.padding};`);
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
