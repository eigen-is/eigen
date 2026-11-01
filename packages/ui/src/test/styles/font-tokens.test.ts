import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getFontFamily, MATH_FONT_STACK } from '@workspace/lib/constants/fonts';

const GLOBALS_CSS = fs.readFileSync(path.join(import.meta.dir, '../../styles/globals.css'), 'utf8');

// CSS can't import the stack builder, so globals.css spells each --font-* token as a literal. This test keeps each
// literal equal to the builder's stack, and on a drift prints the line to paste. Biome writes CSS strings in double
// quotes, and the builder writes single ones, which fit in a style attribute.
test.each([
    ['--font-sans', getFontFamily('Inter')],
    ['--font-serif', getFontFamily('Source Serif 4')],
    ['--font-mono', getFontFamily('JetBrains Mono')],
    ['--font-hand', getFontFamily('Excalifont')],
    ['--font-math', MATH_FONT_STACK],
])('%s is the stack the builder gives', (token, stack) => {
    const expected = `${token}: ${stack.replaceAll("'", '"')};`;
    const line = GLOBALS_CSS.split('\n')
        .map((text) => text.trim())
        .find((text) => text.startsWith(`${token}:`));
    expect(line, `globals.css should read:\n    ${expected}`).toBe(expected);
});
