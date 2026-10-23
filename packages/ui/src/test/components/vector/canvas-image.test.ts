// A downloaded image embeds the faces its text draws in, which the browser fetches as the files fonts.css loads:
// the registry names each by its path under assets/fonts/, and the server embeds the same entries
// (apps/api/src/test/export/fonts.test.ts), so no side keeps a font list of its own.
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FONT_FACES } from '@workspace/lib/constants/fonts';

const SRC = path.join(import.meta.dir, '../../..');

test('the registry is the faces fonts.css loads, each a woff2 the image writer can fetch', () => {
    const css = fs.readFileSync(path.join(SRC, 'styles/fonts.css'), 'utf8');
    const loaded = css
        .split('@font-face')
        .slice(1)
        .map((block) => {
            const field = (name: string) => block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
            const file = block.match(/url\("\.\.\/assets\/fonts\/([^"]+)"\)/)?.[1];
            return `${field('font-family')} | ${file} | ${field('font-weight')} | ${field('font-style')}`;
        })
        .filter((face) => !face.startsWith('"STIX Two Math"'));
    const registry = FONT_FACES.map((face) => `"${face.family}" | ${face.file} | ${face.weight} | ${face.style}`);

    expect(registry).toEqual(loaded);
    for (const face of FONT_FACES) {
        // The writer's glob, assets/fonts/*/*.woff2.
        expect(face.file).toMatch(/^[^/]+\/[^/]+\.woff2$/);
        expect(fs.existsSync(path.join(SRC, 'assets/fonts', face.file))).toBe(true);
    }
});
