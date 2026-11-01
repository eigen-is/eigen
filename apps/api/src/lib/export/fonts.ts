// The bundled fonts as @font-face rules for the HTML and PDF exports and the SVG previews, which have no app to fetch a
// font from. Each rule embeds one slice that the text draws with, its WOFF2 base64'd into a data: URI, picked by
// slicesFor as the browser's image download picks them. Also which bundled families a markup names, and whether a face
// draws its own small caps.

import * as fs from 'node:fs';
import type { FontSlice } from '@workspace/lib/constants/font-slices';
import { fontFaceCss, slicesFor } from '@workspace/lib/constants/font-slices';
import type { BundledFontFace } from '@workspace/lib/constants/fonts';
import { EIGEN_FONT_NAMES, FONT_FACES, TEXT_FALLBACK_FAMILIES } from '@workspace/lib/constants/fonts';

export function hasSmallCaps(family: string, style: BundledFontFace['style']): boolean {
    return FONT_FACES.some((face) => face.family === family && face.style === style && 'smallCaps' in face);
}

// What an export's own CSS draws besides its text: list markers (the disc, numbers, letters and roman numerals), a
// contents entry's dotted leader, and page and footnote numbers. All of it is printable ASCII but the disc, U+2022.
const CSS_DRAWN = [0x2022, ...Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i)];

// A numeric character reference, which an SVG from elsewhere may spell its text in.
const CHARACTER_REFERENCE = /&#(?:x([\da-f]+)|(\d+));/gi;

// The characters a document may draw: those of its markup, the ones its CSS draws, and each letter's other case, since
// CSS caps draw a lowercase letter as its capital. ASCII is always among them, so only the rest of the markup is read,
// which skips the base64 of its pictures quickly. A markup can be megabytes of Chinese, so the loop reads it one UTF-16
// unit at a time instead of building an array of every character.
export function drawnCodePoints(markup: string): Set<number> {
    const drawn = new Set<number>();
    for (let i = 0; i < markup.length; i++) {
        if (markup.charCodeAt(i) < 0x80) continue;
        const codePoint = markup.codePointAt(i) ?? 0;
        drawn.add(codePoint);
        if (codePoint > 0xffff) i++;
    }
    for (const [, hex, decimal] of markup.matchAll(CHARACTER_REFERENCE)) {
        const codePoint = hex ? Number.parseInt(hex, 16) : Number(decimal);
        if (codePoint <= 0x10ffff) drawn.add(codePoint);
    }
    const codePoints = new Set(CSS_DRAWN);
    for (const codePoint of drawn) {
        const char = String.fromCodePoint(codePoint);
        for (const cased of char + char.toUpperCase() + char.toLowerCase()) codePoints.add(cased.codePointAt(0) ?? 0);
    }
    return codePoints;
}

// A font-family in CSS or as an SVG attribute, in a stylesheet, a style attribute or a CSS variable such as a doc's
// --doc-font-family. A quoted attribute is the whole value. A CSS value runs to the end of its declaration, past the
// single-quoted names and the entities in it, but a CSS value that opens with a double quote yields only that name.
const FONT_FAMILY = /font-family\s*(?:=\s*(?:"([^"]*)"|'([^']*)')|:\s*(?:"([^"]*)"|((?:&#?\w+;|'[^']*'|[^;"'>}])+)))/gi;
const NAMED_FAMILIES = new Set([...EIGEN_FONT_NAMES, ...TEXT_FALLBACK_FAMILIES]);

// The bundled text families and fallbacks whose names the markup's font-family values hold. Only a whole name counts,
// so "Interstate" is not Inter, and a name in prose counts for nothing.
export function namedFamilies(markup: string): Set<string> {
    const named = new Set<string>();
    for (const match of markup.matchAll(FONT_FAMILY)) {
        const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
        for (const token of value.split(',')) {
            const name = token.replace(/&apos;|&quot;|&#39;|&#34;|['"]/g, '').trim();
            if (NAMED_FAMILIES.has(name)) named.add(name);
        }
    }
    return named;
}

// The @font-face rules of the slices these families draw these characters with. An unknown family has none.
export function slicesFaceCss(codePoints: ReadonlySet<number>, families: Iterable<string>): string {
    return slicesFor(codePoints, families).map(embeddedSliceCss).join('\n');
}

// The API runs from the repository, so a slice's file is read where the UI package keeps it, by its path under
// assets/fonts/: the path the slice table and the browser's font URLs name it by.
const FONTS_SPECIFIER = '@workspace/ui/assets/fonts/';

// Read and base64 once per slice: the main-thread SVG preview path asks for slices on every request, while a one-shot
// export's child process pays it once anyway. All slices are about 20 MB of base64, but a server holds only those its
// previews touched. A bundled slice that cannot be read is a build defect, so the read is unguarded.
const sliceCssByFile = new Map<string, string>();

function embeddedSliceCss(slice: FontSlice): string {
    let css = sliceCssByFile.get(slice.file);
    if (css === undefined) {
        const bytes = fs.readFileSync(Bun.resolveSync(`${FONTS_SPECIFIER}${slice.file}`, import.meta.dir));
        css = fontFaceCss(slice, `data:font/woff2;base64,${bytes.toString('base64')}`);
        sliceCssByFile.set(slice.file, css);
    }
    return css;
}
