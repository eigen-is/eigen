import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fontFaceCss, slicesFor } from '@workspace/lib/constants/font-slices';
import { weasyPrintPython } from '../../lib/export/weasyprint';

// An export embeds only the slices its text needs, each a file of one family that draws some of its characters. Per
// line one family: Chinese and Korean from several slices, with a space between words, Inter regular and bold from two,
// and the emoji face, whose slices paint each glyph in the text colour, with a ZWJ sequence. printed-glyphs.py reads
// each glyph the PDF draws and compares its outline in the embedded program to the slice's own, so a slice printed with
// another's file fails. WeasyPrint renders with no system font, as in the image: a Mac's or a CI runner's colour emoji
// font would draw the emoji in place of the slices.

const FONTS = join(import.meta.dir, '../../../../../packages/ui/src/assets/fonts');
const RENDER_SCRIPT = join(import.meta.dir, '../../lib/export/weasyprint-render.py');
const SIZE_PX = 20;
const LINES = [
    { family: 'Noto Sans SC', text: '尼德兰荷兰语 是中文的字' },
    { family: 'Noto Sans KR', text: '한국어 텍스트' },
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

// The Python renders run under, when it has fontTools, which WeasyPrint needs and printed-glyphs.py reads fonts with.
async function fontToolsPython(): Promise<string | null> {
    const python = await weasyPrintPython();
    if (python === null) return null;
    const proc = Bun.spawn([python, '-I', '-c', 'import fontTools'], { stdout: 'ignore', stderr: 'ignore' });
    return (await proc.exited) === 0 ? python : null;
}

const python = await fontToolsPython();

const lineSlices = LINES.map(({ family, text }) =>
    slicesFor(new Set(Array.from(text, (character) => character.codePointAt(0) ?? 0)), [family]).filter(
        (slice) => slice.style === 'normal',
    ),
);
const slices = [...new Map(lineSlices.flat().map((slice) => [slice.file, slice])).values()];
const faceCss = slices.map((slice) =>
    fontFaceCss(slice, `data:font/woff2;base64,${readFileSync(join(FONTS, slice.file)).toString('base64')}`),
);

const HTML = `<!DOCTYPE html><html><head><style>
${faceCss.join('\n')}
body { font-size: ${SIZE_PX}px; }
</style></head><body>
${LINES.map((line) => `<p style="font-family: '${line.family}'${line.bold ? '; font-weight: 700' : ''}">${line.text}</p>`).join('\n')}
</body></html>`;

// The render script run in place, with every md5 it computes counted and the count printed on stderr. WeasyPrint is
// imported first, so its own md5 calls are not counted. Run as a module, the script leaves the exit to this wrapper.
const COUNT_DIGESTS = `
import hashlib, runpy, sys
import weasyprint
digests, md5 = 0, hashlib.md5
def counted(*args, **kwargs):
    global digests
    digests += 1
    return md5(*args, **kwargs)
hashlib.md5 = counted
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0])
print(f'digests={digests}', file=sys.stderr)
`;

// A command under a fontconfig that lists no font directory, so only the HTML's @font-face fonts load. A spawn inherits
// the environment the process started with.
async function runWithoutSystemFonts(command: string[], input: string): Promise<{ stdout: Buffer; stderr: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'no-system-fonts-'));
    const fontconfig = join(dir, 'fonts.conf');
    writeFileSync(fontconfig, '<?xml version="1.0"?>\n<fontconfig></fontconfig>\n');
    try {
        return await run(command, input, { ...process.env, FONTCONFIG_FILE: fontconfig });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

async function run(command: string[], input: string, env = process.env): Promise<{ stdout: Buffer; stderr: string }> {
    const proc = Bun.spawn(command, { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    proc.stdin.write(input);
    await proc.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).arrayBuffer(),
        new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`${command[0]} exited with ${exitCode}: ${stderr}`);
    return { stdout: Buffer.from(stdout), stderr };
}

// htmlToPdf in a fresh process, so it starts under the fontconfig without system fonts.
async function htmlToPdfWithoutSystemFonts(html: string): Promise<Buffer> {
    const module = JSON.stringify(Bun.resolveSync('../../lib/export/weasyprint', import.meta.dir));
    const script = `const { htmlToPdf } = await import(${module});
        process.stdout.write(await htmlToPdf(await Bun.stdin.text()));`;
    return (await runWithoutSystemFonts([process.execPath, '-e', script], html)).stdout;
}

async function printedGlyphs(pdf: Buffer, interpreter: string): Promise<PrintedGlyph[]> {
    const request = JSON.stringify({
        pdf: pdf.toString('base64'),
        slices: slices.map((slice) => ({ ...slice, path: join(FONTS, slice.file) })),
        locations: [400, 700].map((wght) => ({ wght, opsz: SIZE_PX })),
    });
    const { stdout } = await run([interpreter, '-I', join(import.meta.dir, 'printed-glyphs.py')], request);
    return JSON.parse(stdout.toString());
}

(python ? describe : describe.skip)('htmlToPdf — font slices of one family', () => {
    test('every line needs at least two slices of its family', () => {
        expect(lineSlices.filter((line) => line.length < 2)).toEqual([]);
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
        // A space between Chinese or Korean words prints in the slice of a word beside it, from that slice's file.
        const spaces = glyphs.filter((glyph) => glyph.text === ' ').map((glyph) => glyph.family);
        expect(spaces).toEqual(expect.arrayContaining(['Noto Sans SC', 'Noto Sans KR']));
    }, 60_000);

    test('each font face is digested once, however many text boxes draw in it', async () => {
        const paragraphs = LINES.map((line) => `<p style="font-family: '${line.family}'">${line.text}</p>`);
        const html = HTML.replace('</body>', `${paragraphs.join('').repeat(100)}</body>`);
        const { stderr } = await runWithoutSystemFonts([python ?? '', '-I', '-c', COUNT_DIGESTS, RENDER_SCRIPT], html);
        // A face is digested once for its key, and each font the PDF embeds once for its tag: one font per slice, and
        // one more for each slice the bold line draws. Without the cache it is a digest per text box, thousands here.
        const fonts = slices.length + lineSlices.filter((_, index) => LINES[index].bold).flat().length;
        const digests = Number(/digests=(\d+)/.exec(stderr)?.[1]);
        expect(digests).toBeGreaterThan(0);
        expect(digests).toBeLessThanOrEqual(slices.length + fonts);
    }, 60_000);
});
