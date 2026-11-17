// A markdown-it plugin for the blocks the site's Markdown writes as fences, such as a looping video, a carousel or a
// media grid: an opener line `::: <name> key="value"`, a body, and a closing `:::`. It runs at build time, so a block
// with a mistake in it, or a file it names that is not under the public folder, fails the build instead of shipping
// a broken page. A block leaves a marker in the HTML, which the page swaps for a component: a media block's marker
// holds its place in the list of what each shows, and a block the page draws itself, such as the About overview's
// app rows, holds its name.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type MarkdownIt from 'markdown-it';
import type { MediaBlock, MediaCaption } from './content-types';
import { gridColumns } from './content-types';

const VIDEO_FILES = ['.av1.mp4', '.h264.mp4', '.webp'];

const MEDIA_BLOCKS = new Set(['video', 'carousel', 'grid']);

// `pageBlocks` names the blocks the page draws itself where the Markdown puts them, such as the About overview's
// `apps`. A page that draws none passes none, so such a block there fails the build as an unknown one. `media` takes
// what each media block shows.
export function markdownBlocks(
    md: MarkdownIt,
    { publicDir, pageBlocks, media }: { publicDir: string; pageBlocks: ReadonlySet<string>; media: MediaBlock[] },
): void {
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
            const html = (content: string) => {
                state.push('html_block', '', 0).content = content;
            };
            const mark = (block: MediaBlock) => {
                html(`<p>[BLOCK:${media.length}]</p>\n`);
                media.push(block);
            };
            // Inline rendering runs a caption through the text rule, so app names in it are set like the prose.
            const captionOf = (markdown: string): MediaCaption => {
                const tokens = md.parseInline(markdown, state.env)[0].children ?? [];
                return {
                    html: md.renderer.renderInline(tokens, md.options, state.env),
                    text: md.renderer.renderInlineAsText(tokens, md.options, state.env),
                };
            };
            const checkFile = (src: string) => {
                if (!src.startsWith('/')) throw new Error(`${where} needs a src that starts with /`);
                const file = join(publicDir, src);
                if (!existsSync(file)) throw new Error(`${where} has no file ${file}`);
            };
            const checkVideo = (src: string) => {
                for (const ext of VIDEO_FILES) checkFile(`${src}${ext}`);
            };
            const images = () => {
                const lines: { src: string; title?: string; caption: MediaCaption }[] = [];
                for (let line = startLine + 1; line < closeLine; line++) {
                    const text = lineText(line);
                    if (!text) continue;
                    const [image, ...others] = md.parseInline(text, state.env)[0].children ?? [];
                    if (image?.type !== 'image' || others.length) {
                        throw new Error(`${where} takes one image per line, not ${text}`);
                    }
                    // The alt text is the caption, which a screen reader reads for the picture or film.
                    if (!image.content.trim()) throw new Error(`${where} needs alt text on ${text}`);
                    lines.push({
                        src: image.attrGet('src') ?? '',
                        title: image.attrGet('title') ?? undefined,
                        caption: captionOf(image.content),
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
                checkVideo(src);
                const caption = attrs.get('caption');
                if (!caption) throw new Error(`${where} needs a caption`);
                mark({ kind: 'video', src, caption: captionOf(caption) });
            } else if (name === 'carousel') {
                // A src with no file ending names a video's files, as a video block's does.
                const groupCaption = attrs.get('caption');
                const slides = images().map(({ src, caption }) => {
                    if (/\.\w+$/.test(src)) return { type: 'image' as const, src, caption };
                    checkVideo(src);
                    return { type: 'video' as const, src, caption };
                });
                mark({
                    kind: 'carousel',
                    slides,
                    autoplay: attrs.has('autoplay'),
                    caption: groupCaption ? captionOf(groupCaption) : undefined,
                });
            } else {
                const columns = gridColumns.find((count) => count === attrs.get('columns'));
                if (!columns) throw new Error(`${where} needs columns from 1 to 6`);
                // An image's title is the small picture the grid shows for it: a thumbnail, or a film's poster.
                const items = images().map(({ src, title, caption }) => {
                    checkFile(src);
                    if (title) checkFile(title);
                    return src.endsWith('.mp4')
                        ? { src, type: 'video' as const, caption: caption.text, poster: title }
                        : { src, type: 'image' as const, caption: caption.text, thumbnail: title };
                });
                mark({ kind: 'grid', columns, items });
            }
            state.line = closeLine + 1;
            return true;
        },
        { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
    );
}
