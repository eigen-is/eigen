import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getFontFamily, MATH_FONT_STACK } from '@workspace/lib/constants/fonts';

// Whitespace collapsed, so a declaration Biome wraps over two lines still reads as one.
const GLOBALS_CSS = fs
    .readFileSync(path.join(import.meta.dir, '../../styles/globals.css'), 'utf8')
    .replace(/\s+/g, ' ');

// CSS can't import the stack builder, so globals.css spells each --font-* token as a literal. This test keeps each
// literal equal to the builder's stack, and on a drift prints the line to paste. Biome writes CSS strings in double
// quotes, and the builder writes single ones, which fit in a style attribute.
// --font-sans and --font-serif also name the ket family globals.css declares, after the last bundled fallback.
const withKet = (stack: string) => stack.replace("'Noto Sans KR', ", "'Noto Sans KR', 'Eigen Ket', ");

test.each([
    ['--font-sans', withKet(getFontFamily('Inter'))],
    ['--font-serif', withKet(getFontFamily('Source Serif 4'))],
    ['--font-mono', getFontFamily('JetBrains Mono')],
    ['--font-hand', getFontFamily('Excalifont')],
    ['--font-math', MATH_FONT_STACK],
])('%s is the stack the builder gives', (token, stack) => {
    const expected = `${token}: ${stack.replaceAll("'", '"')};`;
    const declarations = [...GLOBALS_CSS.matchAll(new RegExp(`${token}:[^;]*;`, 'g'))].map((match) => match[0]);
    expect(declarations, `globals.css should read:\n    ${expected}`).toEqual([expected]);
});
