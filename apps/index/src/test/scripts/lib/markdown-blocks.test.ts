import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import { markdownBlocks } from '../../../../scripts/lib/markdown-blocks';
import { renderMarkdown } from '../../../../scripts/lib/render-markdown';

let publicDir = '';

beforeAll(() => {
    publicDir = mkdtempSync(join(tmpdir(), 'markdown-blocks-'));
    mkdirSync(join(publicDir, 'data/about/media'), { recursive: true });
    for (const ext of ['av1.mp4', 'h264.mp4', 'webp']) writeFileSync(join(publicDir, `data/about/media/a.${ext}`), '');
});

afterAll(() => rmSync(publicDir, { recursive: true, force: true }));

const render = (markdown: string) => new MarkdownIt({ html: true }).use(markdownBlocks, { publicDir }).render(markdown);

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
    test('a carousel wraps its images', () => {
        const html = render('::: carousel caption="The budget"\n![a](/a.webp)\n![b](/b.webp)\n:::');
        expect(html).toContain('<figure class="media-carousel">');
        expect(html).toContain('tabindex="0"');
        expect(html).toContain('class="media-carousel-prev"');
        expect(html).toContain('class="media-carousel-next"');
        expect(html.match(/<img /g)?.length).toBe(2);
        expect(html).toContain('<figcaption>The budget</figcaption>');
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

    test('text after a block renders as usual', () => {
        expect(render('::: carousel\n![a](/a.webp)\n:::\n\nAfter **this**.')).toContain('<strong>this</strong>');
    });
});

describe('mistakes fail the build', () => {
    test('an unknown block name', () => {
        expect(() => render('::: nope\n:::')).toThrow('nope');
    });

    test('a block opener right after a paragraph still opens a block', () => {
        expect(render('Intro text\n::: carousel\n![a](/a.webp)\n:::')).toContain('media-carousel');
    });

    test('a block with no closing fence names its line', () => {
        expect(() => render('Intro\n\n::: carousel\n![a](/a.webp)')).toThrow('line 3');
    });
});
