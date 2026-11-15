import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import type { MediaBlock } from '../../../../scripts/lib/content-types';
import { markdownBlocks } from '../../../../scripts/lib/markdown-blocks';
import { renderMarkdown } from '../../../../scripts/lib/render-markdown';

let publicDir = '';

beforeAll(() => {
    publicDir = mkdtempSync(join(tmpdir(), 'markdown-blocks-'));
    mkdirSync(join(publicDir, 'data/about/media'), { recursive: true });
    for (const ext of ['av1.mp4', 'h264.mp4', 'webp']) writeFileSync(join(publicDir, `data/about/media/a.${ext}`), '');
});

afterAll(() => rmSync(publicDir, { recursive: true, force: true }));

// The HTML of the Markdown, and what each media block it left a marker for shows.
function build(markdown: string, pageBlocks: ReadonlySet<string> = new Set()) {
    const media: MediaBlock[] = [];
    const html = new MarkdownIt({ html: true }).use(markdownBlocks, { publicDir, pageBlocks, media }).render(markdown);
    return { html, media };
}

const render = (markdown: string, pageBlocks?: ReadonlySet<string>) => build(markdown, pageBlocks).html;

describe('grid', () => {
    test('a grid leaves a marker for its place among the media, with one item per image line', () => {
        const { html, media } = build(
            [
                '::: grid columns="3"\n![The *inbox*](/mail.webp "/mail-small.webp")\n\n![](/plain.webp)\n:::',
                'Between',
                '::: grid columns="1"\n![A film](/film.mp4 "/film.webp")\n:::',
            ].join('\n\n'),
        );
        expect(html).toBe('<p>[BLOCK:0]</p>\n<p>Between</p>\n<p>[BLOCK:1]</p>\n');
        expect(media).toEqual([
            {
                kind: 'grid',
                columns: '3',
                items: [
                    { src: '/mail.webp', type: 'image', caption: 'The inbox', thumbnail: '/mail-small.webp' },
                    { src: '/plain.webp', type: 'image', caption: undefined, thumbnail: undefined },
                ],
            },
            {
                kind: 'grid',
                columns: '1',
                items: [{ src: '/film.mp4', type: 'video', caption: 'A film', poster: '/film.webp' }],
            },
        ]);
    });

    test('a grid without columns from 1 to 6, or without an image, fails the build', () => {
        expect(() => render('::: grid\n![a](/a.webp)\n:::')).toThrow('columns from 1 to 6');
        expect(() => render('::: grid columns="7"\n![a](/a.webp)\n:::')).toThrow('columns from 1 to 6');
        expect(() => render('::: grid columns="2"\n:::')).toThrow('needs an image');
        expect(() => render('::: grid columns="2"\ntext\n:::')).toThrow('one image per line');
    });
});

describe('video', () => {
    test('a video block leaves a marker, its files and its caption, as Markdown and as text', () => {
        const { html, media } = build('::: video src="/data/about/media/a" caption="Two *people* at once"\n:::');
        expect(html).toBe('<p>[BLOCK:0]</p>\n');
        expect(media).toEqual([
            {
                kind: 'video',
                src: '/data/about/media/a',
                caption: { html: 'Two <em>people</em> at once', text: 'Two people at once' },
            },
        ]);
    });

    test('a video whose files are missing fails the build', () => {
        expect(() => render('::: video src="/data/about/media/missing"\n:::')).toThrow(
            '/data/about/media/missing.av1.mp4',
        );
    });

    test('a video without src fails the build', () => {
        expect(() => render('::: video\n:::')).toThrow('src');
    });

    test('a video with a relative src fails the build with its line', () => {
        expect(() => render('Intro\n\n::: video src="data/about/media/a"\n:::')).toThrow('line 3');
    });
});

describe('carousel', () => {
    test('a carousel leaves a marker and a slide per image line, captioned with its alt text', () => {
        const { html, media } = build(
            '::: carousel caption="The budget"\n![a](/a.webp)\n![b *bold*](/b.webp)\n\n![](/c.webp)\n:::',
        );
        expect(html).toBe('<p>[BLOCK:0]</p>\n');
        expect(media).toEqual([
            {
                kind: 'carousel',
                slides: [
                    { type: 'image', src: '/a.webp', caption: { html: 'a', text: 'a' } },
                    { type: 'image', src: '/b.webp', caption: { html: 'b <em>bold</em>', text: 'b bold' } },
                    { type: 'image', src: '/c.webp', caption: undefined },
                ],
                autoplay: false,
                caption: { html: 'The budget', text: 'The budget' },
            },
        ]);
    });

    test('an image line without a file ending is a video slide, captioned with its alt text', () => {
        const { media } = build('::: carousel\n![Two at once](/data/about/media/a)\n![b](/b.webp)\n:::');
        expect(media).toEqual([
            {
                kind: 'carousel',
                slides: [
                    {
                        type: 'video',
                        src: '/data/about/media/a',
                        caption: { html: 'Two at once', text: 'Two at once' },
                    },
                    { type: 'image', src: '/b.webp', caption: { html: 'b', text: 'b' } },
                ],
                autoplay: false,
                caption: undefined,
            },
        ]);
    });

    test('a video slide whose files are missing fails the build', () => {
        expect(() => render('::: carousel\n![x](/data/about/media/missing)\n:::')).toThrow(
            '/data/about/media/missing.av1.mp4',
        );
    });

    test('an autoplay carousel says so to the page', () => {
        expect(build('::: carousel autoplay caption="Shots"\n![a](/a.webp)\n:::').media).toMatchObject([
            { autoplay: true, caption: { text: 'Shots' } },
        ]);
    });

    test('a carousel line that is not one image, or a carousel with none, fails the build', () => {
        expect(() => render('::: carousel\n![a](/a.webp) and text\n:::')).toThrow('one image per line');
        expect(() => render('::: carousel\n:::')).toThrow('needs an image');
    });

    test('an app name in a caption is set as a ket, and stays plain in its text', () => {
        const { media } = renderMarkdown('::: carousel caption="eigen|sheets⟩ live"\n![In eigen|mail⟩](/a.webp)\n:::');
        expect(media).toMatchObject([
            {
                slides: [{ caption: { html: 'In <span class="ket-name">eigen|mail⟩</span>', text: 'In eigen|mail⟩' } }],
                caption: { html: '<span class="ket-name">eigen|sheets⟩</span> live', text: 'eigen|sheets⟩ live' },
            },
        ]);
    });

    test('a block the page draws leaves a marker with its name', () => {
        const pageBlocks = new Set(['apps', 'principles']);
        expect(render('Intro\n\n::: apps\n:::\n\nAfter', pageBlocks)).toContain('<p>[BLOCK:apps]</p>');
        expect(render('::: principles\n:::', pageBlocks)).toContain('<p>[BLOCK:principles]</p>');
        expect(() => render('::: apps\n![a](/a.webp)\n:::', pageBlocks)).toThrow('takes no body');
    });

    test('text after a block renders as usual', () => {
        expect(render('::: carousel\n![a](/a.webp)\n:::\n\nAfter **this**.')).toContain('<strong>this</strong>');
    });
});

describe('mistakes fail the build', () => {
    test('an unknown block name', () => {
        expect(() => render('::: nope\n:::')).toThrow('nope');
        expect(() => render('::: side-by-side\n![a](/a.webp)\n:::')).toThrow('Unknown Markdown block');
    });

    test('a block of a page that draws none, such as a blog post', () => {
        expect(() => render('Intro\n\n::: apps\n:::')).toThrow('::: apps on line 3');
        expect(() => render('::: formats\n:::', new Set(['apps']))).toThrow('::: formats on line 1');
    });

    test('a block opener right after a paragraph still opens a block', () => {
        expect(render('Intro text\n::: carousel\n![a](/a.webp)\n:::')).toBe('<p>Intro text</p>\n<p>[BLOCK:0]</p>\n');
    });

    test('a block with no closing fence names its line', () => {
        expect(() => render('Intro\n\n::: carousel\n![a](/a.webp)')).toThrow('line 3');
    });
});
