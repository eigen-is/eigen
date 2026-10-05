import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getFontCSS } from '../../lib/export/fonts';

const UI_STYLES_DIR = path.join(import.meta.dir, '../../../../../packages/ui/src/styles');

function faces(css: string, bytesOf: (src: string) => Buffer): string[] {
    return css
        .split('@font-face')
        .slice(1)
        .map((block) => {
            const field = (name: string) => block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
            const src = block.match(/url\("([^"]+)"\)/)?.[1] ?? '';
            const hash = createHash('sha256').update(bytesOf(src)).digest('hex');
            return `${field('font-family')} | ${field('font-weight')} | ${field('font-style')} | ${hash}`;
        })
        .sort();
}

// An export inlines the faces the apps load from fonts.css; a face added or changed on one side only
// renders an export in a fallback font.
test('the export fonts are the faces the apps load', () => {
    const appCSS = fs.readFileSync(path.join(UI_STYLES_DIR, 'fonts.css'), 'utf8');
    const appFaces = faces(appCSS, (src) => fs.readFileSync(path.join(UI_STYLES_DIR, src)));
    const exportFaces = faces(getFontCSS(), (src) => Buffer.from(src.slice(src.indexOf(',') + 1), 'base64'));
    expect(appFaces).toHaveLength(6);
    expect(exportFaces).toEqual(appFaces);
});
