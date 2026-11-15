// A markdown-it plugin for the blocks the site's Markdown writes as fences, such as a looping video, a carousel or a
// side-by-side pair: an opener line `::: <name> key="value"`, a body, and a closing `:::`. It runs at build time, so a
// block with a mistake in it, or a video whose files are not under the public folder, fails the build instead of
// shipping a broken page. A carousel comes out whole, its slides, dots and buttons included, and the page wires them
// up and starts the videos. A block the page draws itself, such as the About overview's app rows, leaves a marker
// with its name, on the pages that draw it.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type MarkdownIt from 'markdown-it';
import type { MediaGridData } from './content-types';

// Lucide "chevron-left" and "chevron-right", inlined like the heading anchor icon.
const chevron = (path: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
const PREV_ICON = chevron('m15 18-6-6 6-6');
const NEXT_ICON = chevron('m9 18 6-6-6-6');

const VIDEO_FILES = ['.av1.mp4', '.h264.mp4', '.webp'];

const MEDIA_BLOCKS = new Set(['video', 'carousel', 'grid', 'side-by-side']);

// `pageBlocks` names the blocks the page draws itself where the Markdown puts them, such as the About overview's
// `apps`. A page that draws none passes none, so such a block there fails the build as an unknown one. `media` takes
// what each media block the page draws shows, and the block's marker holds its place in it.
export function markdownBlocks(
    md: MarkdownIt,
    { publicDir, pageBlocks, media }: { publicDir: string; pageBlocks: ReadonlySet<string>; media: MediaGridData[] },
): void {
    const { escapeHtml } = md.utils;
    // Inline rendering runs the caption through the text rule, so app names in it are set like the prose around it.
    const figcaption = (caption?: string) => (caption ? `<figcaption>${md.renderInline(caption)}</figcaption>` : '');

    md.block.ruler.before(
        'fence',
        'media_block',
        (state, startLine, _endLine, silent) => {
            if (state.sCount[startLine] - state.blkIndent >= 4) return false;
            const lineText = (line: number) =>
                state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]).trim();
            const opener = lineText(startLine).match(/^:::\s+([\w-]+)(.*)$/);
            if (!opener) return false;

            const [, name, rest] = opener;
            const where = `::: ${name} on line ${startLine + 1}`;
            const pageBlock = pageBlocks.has(name);
            if (!MEDIA_BLOCKS.has(name) && !pageBlock) throw new Error(`Unknown Markdown block ${where}`);
            let closeLine = startLine + 1;
            while (closeLine < state.lineMax && lineText(closeLine) !== ':::') closeLine++;
            if (closeLine >= state.lineMax) throw new Error(`${where} has no closing :::`);
            if (silent) return true;

            // A key without a value, such as `autoplay`, is a switch.
            const attrs = new Map(
                Array.from(rest.matchAll(/(\w[\w-]*)(?:="([^"]*)")?/g), ([, key, value]) => [key, value]),
            );
            const caption = attrs.get('caption');
            const html = (content: string) => {
                state.push('html_block', '', 0).content = content;
            };
            // A muted loop with no autoplay, so the page starts it only for a reader who did not ask for less motion.
            const video = (src: string) => {
                if (!src.startsWith('/')) throw new Error(`${where} needs a src that starts with /`);
                for (const ext of VIDEO_FILES) {
                    const file = join(publicDir, `${src}${ext}`);
                    if (!existsSync(file)) throw new Error(`${where} has no file ${file}`);
                }
                const base = escapeHtml(src);
                // Every video stays within level 4.0, about 2048×1088, so a browser that says yes to it can decode it.
                return `<video muted loop playsinline preload="metadata" poster="${base}.webp"><source src="${base}.av1.mp4" type='video/mp4; codecs="av01.0.08M.08"'><source src="${base}.h264.mp4" type="video/mp4"></video>`;
            };

            const images = () => {
                const lines: { src: string; title?: string; alt: string; caption: string; markdown: string }[] = [];
                for (let line = startLine + 1; line < closeLine; line++) {
                    const text = lineText(line);
                    if (!text) continue;
                    const [image, ...others] = md.parseInline(text, state.env)[0].children ?? [];
                    if (image?.type !== 'image' || others.length) {
                        throw new Error(`${where} takes one image per line, not ${text}`);
                    }
                    lines.push({
                        src: image.attrGet('src') ?? '',
                        title: image.attrGet('title') ?? undefined,
                        alt: md.renderer.renderInlineAsText(image.children ?? [], md.options, state.env),
                        caption: image.content,
                        markdown: text,
                    });
                }
                if (!lines.length) throw new Error(`${where} needs an image`);
                return lines;
            };

            if ((name === 'video' || pageBlock) && closeLine > startLine + 1) {
                throw new Error(`${where} takes no body`);
            }
            if (pageBlock) {
                html(`<p>[BLOCK:${name}]</p>\n`);
            } else if (name === 'video') {
                const src = attrs.get('src');
                if (!src) throw new Error(`${where} needs a src`);
                html(`<figure class="media-video">${video(src)}${figcaption(caption)}</figure>\n`);
            } else if (name === 'carousel') {
                // A src with no file ending names a video's files, as a video block's does.
                const slides = images().map(({ src, caption, markdown }) => {
                    const slide = /\.\w+$/.test(src) ? md.renderInline(markdown) : video(src);
                    return `<figure class="media-carousel-slide">${slide}${figcaption(caption)}</figure>\n`;
                });
                const dots = slides.map(
                    (_, i) =>
                        `<button type="button" class="media-carousel-dot" aria-label="Slide ${i + 1} of ${slides.length}"${i === 0 ? ' aria-current="true"' : ''}></button>`,
                );
                const nextDisabled = slides.length < 2 ? ' disabled' : '';
                html(
                    `<figure class="media-carousel"${attrs.has('autoplay') ? ' data-autoplay' : ''}><div class="media-carousel-strip" tabindex="0" aria-label="${escapeHtml(caption ?? 'Slides')}">\n${slides.join('')}</div><div class="media-carousel-nav"><div class="media-carousel-dots">${dots.join('')}</div><div class="media-carousel-steps"><button type="button" class="media-carousel-prev" aria-label="Previous slide" disabled>${PREV_ICON}</button><button type="button" class="media-carousel-next" aria-label="Next slide"${nextDisabled}>${NEXT_ICON}</button></div></div>${figcaption(caption)}</figure>\n`,
                );
            } else if (name === 'grid') {
                const columns = attrs.get('columns');
                if (!columns || !/^[1-6]$/.test(columns)) throw new Error(`${where} needs columns from 1 to 6`);
                // An image's title is the small picture the grid shows for it: a thumbnail, or a film's poster.
                const items = images().map(({ src, title, alt }) =>
                    src.endsWith('.mp4')
                        ? { src, type: 'video' as const, caption: alt, poster: title }
                        : { src, type: 'image' as const, caption: alt, thumbnail: title },
                );
                html(`<p>[BLOCK:${media.length}]</p>\n`);
                media.push({ columns, items });
            } else {
                html('<figure class="media-side-by-side">\n');
                const lineMax = state.lineMax;
                state.lineMax = closeLine;
                state.md.block.tokenize(state, startLine + 1, closeLine);
                state.lineMax = lineMax;
                html(`${figcaption(caption)}</figure>\n`);
            }
            state.line = closeLine + 1;
            return true;
        },
        { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
    );
}
