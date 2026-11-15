import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import type { MediaGridData } from '../../../../scripts/lib/content-types';
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
    const media: MediaGridData[] = [];
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
                columns: '3',
                items: [
                    { src: '/mail.webp', type: 'image', caption: 'The inbox', thumbnail: '/mail-small.webp' },
                    { src: '/plain.webp', type: 'image', caption: '', thumbnail: undefined },
                ],
            },
            { columns: '1', items: [{ src: '/film.mp4', type: 'video', caption: 'A film', poster: '/film.webp' }] },
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
    test('a video block is a muted loop with both encodes and a poster, which the page starts', () => {
        const html = render('::: video src="/data/about/media/a" caption="Two people at once"\n:::');
        expect(html).toContain('<figure class="media-video"><video muted loop playsinline preload="metadata"');
        expect(html).not.toContain('autoplay');
        expect(html).toContain('poster="/data/about/media/a.webp"');
        expect(html).toContain('src="/data/about/media/a.av1.mp4"');
        expect(html).toContain('src="/data/about/media/a.h264.mp4"');
        expect(html).toContain('<figcaption>Two people at once</figcaption>');
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

describe('carousel and side by side', () => {
    test('a carousel sets each image on a slide captioned with its alt text, with dots and buttons below', () => {
        const html = render('::: carousel caption="The budget"\n![a](/a.webp)\n![b *bold*](/b.webp)\n:::');
        expect(html).toContain('<figure class="media-carousel">');
        expect(html).toContain('<div class="media-carousel-strip" tabindex="0" aria-label="The budget">');
        expect(html).toContain(
            '<figure class="media-carousel-slide"><img src="/a.webp" alt="a"><figcaption>a</figcaption></figure>',
        );
        expect(html).toContain('<img src="/b.webp" alt="b bold"><figcaption>b <em>bold</em></figcaption>');
        expect(html).toContain(
            '<button type="button" class="media-carousel-dot" aria-label="Slide 1 of 2" aria-current="true"></button>',
        );
        expect(html).toContain('<button type="button" class="media-carousel-dot" aria-label="Slide 2 of 2"></button>');
        expect(html).toContain('class="media-carousel-prev" aria-label="Previous slide" disabled>');
        expect(html).toContain('class="media-carousel-next" aria-label="Next slide">');
        expect(html.match(/<img /g)?.length).toBe(2);
        expect(html).toContain('<figcaption>The budget</figcaption></figure>');
    });

    test('an image line without a file ending is a video slide, a loop the page starts, captioned with its alt text', () => {
        const html = render('::: carousel\n![Two at once](/data/about/media/a)\n![b](/b.webp)\n:::');
        expect(html).toContain(
            '<figure class="media-carousel-slide"><video muted loop playsinline preload="metadata" poster="/data/about/media/a.webp"><source src="/data/about/media/a.av1.mp4"',
        );
        expect(html).toContain(
            '<source src="/data/about/media/a.h264.mp4" type="video/mp4"></video><figcaption>Two at once</figcaption></figure>',
        );
        expect(html).not.toContain('autoplay');
        expect(html.match(/<img /g)?.length).toBe(1);
    });

    test('a video slide whose files are missing fails the build', () => {
        expect(() => render('::: carousel\n![x](/data/about/media/missing)\n:::')).toThrow(
            '/data/about/media/missing.av1.mp4',
        );
    });

    test('an autoplay carousel says so to the page', () => {
        expect(render('::: carousel autoplay caption="Shots"\n![a](/a.webp)\n:::')).toContain(
            '<figure class="media-carousel" data-autoplay>',
        );
        expect(render('::: carousel\n![a](/a.webp)\n:::')).toContain('<figure class="media-carousel">');
    });

    test('a carousel of one image has both buttons off', () => {
        const html = render('::: carousel\n![a](/a.webp)\n:::');
        expect(html).toContain('aria-label="Slides"');
        expect(html).toContain('class="media-carousel-next" aria-label="Next slide" disabled>');
    });

    test('a carousel line that is not one image fails the build', () => {
        expect(() => render('::: carousel\n![a](/a.webp) and text\n:::')).toThrow('one image per line');
    });

    test('an app name in a caption is set as a ket', () => {
        expect(renderMarkdown('::: carousel caption="eigen|sheets⟩ live"\n![a](/a.webp)\n:::').html).toContain(
            '<figcaption><span class="ket-name">eigen|sheets⟩</span> live</figcaption>',
        );
    });

    test('a side-by-side pair wraps its images', () => {
        const html = render('::: side-by-side\n![a](/a.webp) ![b](/b.webp)\n:::');
        expect(html).toContain('<figure class="media-side-by-side">');
        expect(html.match(/<img /g)?.length).toBe(2);
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
    });

    test('a block of a page that draws none, such as a blog post', () => {
        expect(() => render('Intro\n\n::: apps\n:::')).toThrow('::: apps on line 3');
        expect(() => render('::: formats\n:::', new Set(['apps']))).toThrow('::: formats on line 1');
    });

    test('a block opener right after a paragraph still opens a block', () => {
        expect(render('Intro text\n::: carousel\n![a](/a.webp)\n:::')).toContain('media-carousel');
    });

    test('a block with no closing fence names its line', () => {
        expect(() => render('Intro\n\n::: carousel\n![a](/a.webp)')).toThrow('line 3');
    });
});
