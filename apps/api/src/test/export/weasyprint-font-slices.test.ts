import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FontSlice } from '@workspace/lib/constants/font-slices';
import { slicesFor } from '@workspace/lib/constants/font-slices';
import { isWeasyPrintAvailable, shebangPython } from '../../lib/export/weasyprint';

// An export embeds only the slices its text needs, each a file of one family that draws some of its characters. Per
// line one family: Chinese and Korean from several slices, Inter regular and bold from two, and the emoji face, whose
// slices paint each glyph in the text colour, with a ZWJ sequence. printed-glyphs.py reads each glyph the PDF draws
// and compares its outline in the embedded program to the slice's own, so a slice printed with another's file fails.
// WeasyPrint renders with no system font, as in the image: a Mac's or a CI runner's colour emoji font would draw the
// emoji in place of the slices.

const FONTS = join(import.meta.dir, '../../../../../packages/ui/src/assets/fonts');
const SIZE_PX = 20;
const LINES = [
    { family: 'Noto Sans SC', text: '尼德兰荷兰语是中文的字' },
    { family: 'Noto Sans KR', text: '한국어텍스트' },
    { family: 'Inter', text: 'Hello Ŵőŕł' },
    { family: 'Inter', text: 'Bold Ŵőŕł', bold: true },
    { family: 'Eigen Emoji', text: `😀${String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb)}❤🚀` },
];

type PrintedGlyph = {
    family: string;
    program: number;
    text: string;
    slice: string | null;
    outline: 'same' | 'other' | 'blank' | 'notdef' | 'no slice' | 'several slices';
};

// The Python the `weasyprint` launcher names, as htmlToPdf picks it, when it has fontTools, which WeasyPrint needs.
async function fontToolsPython(): Promise<string | null> {
    const launcher = Bun.which('weasyprint');
    const python = (launcher && shebangPython(await Bun.file(launcher).slice(0, 512).text())) || 'python3';
    const proc = Bun.spawn([python, '-I', '-c', 'import fontTools'], { stdout: 'ignore', stderr: 'ignore' });
    return (await proc.exited) === 0 ? python : null;
}

const python = (await isWeasyPrintAvailable()) ? await fontToolsPython() : null;

const lineSlices = LINES.map(({ family, text }) =>
    slicesFor(new Set(Array.from(text, (character) => character.codePointAt(0) ?? 0)), [family]).filter(
        (slice) => slice.style === 'normal',
    ),
);
const slices = [...new Map(lineSlices.flat().map((slice) => [slice.file, slice])).values()];

function fontFace(slice: FontSlice): string {
    const data = readFileSync(join(FONTS, slice.file)).toString('base64');
    return `@font-face { font-family: '${slice.family}'; font-style: ${slice.style}; font-weight: ${slice.weight};
        src: url(data:font/woff2;base64,${data}) format('woff2'); unicode-range: ${slice.unicodeRange}; }`;
}

const HTML = `<!DOCTYPE html><html><head><style>
${slices.map(fontFace).join('\n')}
body { font-size: ${SIZE_PX}px; }
</style></head><body>
${LINES.map((line) => `<p style="font-family: '${line.family}'${line.bold ? '; font-weight: 700' : ''}">${line.text}</p>`).join('\n')}
</body></html>`;

// htmlToPdf in a fresh process under a fontconfig that lists no font directory, so only the HTML's @font-face fonts
// load. A spawn inherits the environment the process started with.
async function htmlToPdfWithoutSystemFonts(html: string): Promise<Buffer> {
    const dir = mkdtempSync(join(tmpdir(), 'no-system-fonts-'));
    const fontconfig = join(dir, 'fonts.conf');
    writeFileSync(fontconfig, '<?xml version="1.0"?>\n<fontconfig></fontconfig>\n');
    try {
        const module = JSON.stringify(Bun.resolveSync('../../lib/export/weasyprint', import.meta.dir));
        const proc = Bun.spawn(
            [
                process.execPath,
                '-e',
                `const { htmlToPdf } = await import(${module});
                process.stdout.write(await htmlToPdf(await Bun.stdin.text()));`,
            ],
            { env: { ...process.env, FONTCONFIG_FILE: fontconfig }, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
        );
        proc.stdin.write(html);
        await proc.stdin.end();
        const [exitCode, pdf] = await Promise.all([proc.exited, new Response(proc.stdout).arrayBuffer()]);
        expect(exitCode).toBe(0);
        return Buffer.from(pdf);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

async function printedGlyphs(pdf: Buffer, interpreter: string): Promise<PrintedGlyph[]> {
    const proc = Bun.spawn([interpreter, '-I', join(import.meta.dir, 'printed-glyphs.py')], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'inherit',
    });
    proc.stdin.write(
        JSON.stringify({
            pdf: pdf.toString('base64'),
            slices: slices.map((slice) => ({ ...slice, path: join(FONTS, slice.file) })),
            locations: [400, 700].map((wght) => ({ wght, opsz: SIZE_PX })),
        }),
    );
    await proc.stdin.end();
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).json()]);
    expect(exitCode).toBe(0);
    return stdout;
}

(python ? describe : describe.skip)('htmlToPdf — font slices of one family', () => {
    test('the text needs several slices of each family', () => {
        expect(lineSlices.map((line) => line.length)).toEqual([7, 4, 2, 2, 2]);
    });

    test('every glyph prints its own slice outline, from one font program per slice file', async () => {
        const glyphs = await printedGlyphs(await htmlToPdfWithoutSystemFonts(HTML), python ?? '');

        expect(glyphs.filter((glyph) => glyph.outline !== 'same')).toEqual([]);
        expect(new Set(glyphs.map((glyph) => glyph.slice))).toEqual(new Set(slices.map((slice) => slice.file)));
        const filesByProgram = Map.groupBy(glyphs, (glyph) => glyph.program);
        expect(
            [...filesByProgram.values()].filter((program) => new Set(program.map((glyph) => glyph.slice)).size > 1),
        ).toEqual([]);
        // The ZWJ sequence prints as the one glyph its slice draws for it.
        expect(glyphs.map((glyph) => glyph.text)).toContain(String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb));
    }, 60_000);
});
