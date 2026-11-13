import { describe, expect, test } from 'bun:test';
import { renderMarkdown } from '../../../../scripts/lib/render-markdown';

describe('renderMarkdown', () => {
    test('renders Markdown to HTML', () => {
        const { html } = renderMarkdown('# Hi\n\nA **paragraph**.');
        expect(html).toContain('<h1');
        expect(html).toContain('<strong>paragraph</strong>');
    });

    test('extracts h2/h3 headings into the TOC with slug ids', () => {
        const { toc } = renderMarkdown('## Permission levels\n\ntext\n\n### Shared links');
        expect(toc).toEqual([
            { id: 'permission-levels', text: 'Permission levels', level: 2 },
            { id: 'shared-links', text: 'Shared links', level: 3 },
        ]);
    });

    test('headings in the HTML carry the matching id', () => {
        const { html } = renderMarkdown('## Permission levels');
        expect(html).toContain('id="permission-levels"');
    });

    test('h1 is not included in the TOC', () => {
        const { toc } = renderMarkdown('# Title\n\n## Section');
        expect(toc.map((t) => t.level)).toEqual([2]);
    });

    describe('app names', () => {
        const ket = (name: string) => `<span class="ket-name">${name}</span>`;

        test('wraps a name in a sentence', () => {
            expect(renderMarkdown('Open eigen|mail⟩ to read.').html).toBe(
                `<p>Open ${ket('eigen|mail⟩')} to read.</p>\n`,
            );
        });

        test('wraps a name in bold', () => {
            expect(renderMarkdown('**eigen|mail⟩**: webmail').html).toContain(`<strong>${ket('eigen|mail⟩')}</strong>`);
        });

        test('wraps a name in a heading and keeps its id and TOC text', () => {
            const { html, toc } = renderMarkdown('## Inside eigen|docs⟩');
            expect(html).toContain(`Inside ${ket('eigen|docs⟩')}`);
            expect(html).toContain('id="inside-eigendocs"');
            expect(toc).toEqual([{ id: 'inside-eigendocs', text: 'Inside eigen|docs⟩', level: 2 }]);
        });

        test('wraps a name in link text but not in its URL', () => {
            const { html } = renderMarkdown('[eigen|drive⟩](https://eigen.is/eigen|drive⟩)');
            expect(html).toContain(`>${ket('eigen|drive⟩')}</a>`);
            expect(html).toContain('href="https://eigen.is/eigen%7Cdrive%E2%9F%A9"');
        });

        test('wraps two names in one paragraph', () => {
            const { html } = renderMarkdown('eigen|mail⟩ and eigen|calendar⟩ share contacts.');
            expect(html).toBe(`<p>${ket('eigen|mail⟩')} and ${ket('eigen|calendar⟩')} share contacts.</p>\n`);
        });

        test('leaves code, URLs, an ASCII ket, the bare word and table cells alone', () => {
            const sources = [
                'Run `eigen|mail⟩` here.',
                '```\neigen|mail⟩\n```',
                'See https://eigen.is/eigen|mail⟩ now.',
                'The API answers eigen|api> at its root.',
                'Eigen and eigen are words.',
                '| a | b |\n|---|---|\n| eigen | mail⟩ |',
            ];
            for (const source of sources) expect(renderMarkdown(source).html).not.toContain('ket-name');
        });
    });
});
