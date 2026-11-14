// A markdown-it plugin for the media blocks the site's Markdown writes as fences, such as a looping video, a carousel
// or a side-by-side pair: an opener line `::: <name> key="value"`, a body, and a closing `:::`. It runs at build
// time, so a block with a mistake in it, or a video whose files are not under the public folder, fails the build
// instead of shipping a broken page. The page wires up the carousel buttons.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type MarkdownIt from 'markdown-it';

// Lucide "chevron-left" and "chevron-right", inlined like the heading anchor icon.
const chevron = (path: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
const PREV_ICON = chevron('m15 18-6-6 6-6');
const NEXT_ICON = chevron('m9 18 6-6-6-6');

const VIDEO_FILES = ['.av1.mp4', '.h264.mp4', '.webp'];

export function markdownBlocks(md: MarkdownIt, { publicDir }: { publicDir: string }): void {
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
            if (name !== 'video' && name !== 'carousel' && name !== 'side-by-side') {
                throw new Error(`Unknown Markdown block ${where}`);
            }
            let closeLine = startLine + 1;
            while (closeLine < state.lineMax && lineText(closeLine) !== ':::') closeLine++;
            if (closeLine >= state.lineMax) throw new Error(`${where} has no closing :::`);
            if (silent) return true;

            const attrs = new Map(Array.from(rest.matchAll(/(\w[\w-]*)="([^"]*)"/g), ([, key, value]) => [key, value]));
            const caption = attrs.get('caption');
            const html = (content: string) => {
                state.push('html_block', '', 0).content = content;
            };
            const tokenizeBody = () => {
                const lineMax = state.lineMax;
                state.lineMax = closeLine;
                state.md.block.tokenize(state, startLine + 1, closeLine);
                state.lineMax = lineMax;
            };

            if (name === 'video') {
                const src = attrs.get('src');
                if (!src) throw new Error(`${where} needs a src`);
                if (closeLine > startLine + 1) throw new Error(`${where} takes no body`);
                for (const ext of VIDEO_FILES) {
                    const file = join(publicDir, `${src}${ext}`);
                    if (!existsSync(file)) throw new Error(`${where} has no file ${file}`);
                }
                const base = escapeHtml(src);
                html(
                    `<figure class="media-video"><video autoplay muted loop playsinline preload="metadata" poster="${base}.webp"><source src="${base}.av1.mp4" type='video/mp4; codecs="av01.0.08M.08"'><source src="${base}.h264.mp4" type="video/mp4"></video>${figcaption(caption)}</figure>\n`,
                );
            } else if (name === 'carousel') {
                html(
                    `<figure class="media-carousel"><div class="media-carousel-strip" tabindex="0" aria-label="${escapeHtml(caption ?? 'Images')}">\n`,
                );
                tokenizeBody();
                html(
                    `</div><button type="button" class="media-carousel-prev" aria-label="Previous image">${PREV_ICON}</button><button type="button" class="media-carousel-next" aria-label="Next image">${NEXT_ICON}</button>${figcaption(caption)}</figure>\n`,
                );
            } else {
                html('<figure class="media-side-by-side">\n');
                tokenizeBody();
                html(`${figcaption(caption)}</figure>\n`);
            }
            state.line = closeLine + 1;
            return true;
        },
        { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
    );
}
