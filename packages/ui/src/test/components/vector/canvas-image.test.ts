// A downloaded image embeds the slices its text draws with, which the browser fetches as the files the font CSS loads:
// the range data names each by its path under assets/fonts/, and the server embeds the same slices
// (apps/api/src/test/export/fonts.test.ts), so no side keeps a font list of its own. fonts.css and fonts-cjk.css are
// generated from the range data, one rule per slice.
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FontSlice } from '@workspace/lib/constants/font-slices';
import { FONT_SLICES } from '@workspace/lib/constants/font-slices';
import { FALLBACK_FONTS, FONT_FACES } from '@workspace/lib/constants/fonts';

const CJK_FAMILIES = new Set(FALLBACK_FONTS.filter((font) => font.kind === 'cjk').map((font) => font.family));

const SRC = path.join(import.meta.dir, '../../..');

function loadedSlices(file: string): string[] {
    const css = fs.readFileSync(path.join(SRC, 'styles', file), 'utf8');
    return css
        .split('@font-face')
        .slice(1)
        .map((block) => {
            const field = (name: string) =>
                block
                    .match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]
                    .trim()
                    .replace(/\s+/g, ' ');
            const file = block.match(/url\("\.\.\/assets\/fonts\/([^"]+)"\)/)?.[1];
            return `${field('font-family')} | ${file} | ${field('font-weight')} | ${field('font-style')} | ${field('unicode-range')}`;
        });
}

test('fonts.css and fonts-cjk.css load the slices of the range data, each a woff2 the image writer can fetch', () => {
    const row = (slice: FontSlice) =>
        `"${slice.family}" | ${slice.file} | ${slice.weight} | ${slice.style} | ${slice.unicodeRange}`;
    const cjk = (slice: FontSlice) => CJK_FAMILIES.has(slice.family);
    expect(loadedSlices('fonts.css')).toEqual(FONT_SLICES.filter((slice) => !cjk(slice)).map(row));
    expect(loadedSlices('fonts-cjk.css')).toEqual(FONT_SLICES.filter(cjk).map(row));
    for (const slice of FONT_SLICES) {
        // The writer's glob, assets/fonts/*/*.woff2.
        expect(slice.file).toMatch(/^[^/]+\/[^/]+\.woff2$/);
        expect(fs.existsSync(path.join(SRC, 'assets/fonts', slice.file))).toBe(true);
    }
});

test('the registry faces are files the image writer can fetch, and fonts.css slices each one', () => {
    for (const face of FONT_FACES) {
        expect(face.file).toMatch(/^[^/]+\/[^/]+\.woff2$/);
        expect(fs.existsSync(path.join(SRC, 'assets/fonts', face.file))).toBe(true);
        const slices = FONT_SLICES.filter(
            (slice) => slice.family === face.family && slice.weight === face.weight && slice.style === face.style,
        );
        expect(slices.length).toBeGreaterThan(0);
    }
});
