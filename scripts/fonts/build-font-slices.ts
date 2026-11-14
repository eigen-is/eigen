// Cuts every bundled face into unicode-range slices, as Google Fonts serves its fonts, so a page or an export loads
// only the slices its text draws. It downloads each fallback font from a pinned URL and writes the WOFF2 slices, the
// @font-face CSS the apps load (the Chinese and Korean faces in a file of their own) and the range data slicesFor reads.
// Run it by hand when a font changes, with a Python venv that has fontTools and brotli, at EIGEN_FONTS_PYTHON or
// ~/.cache/eigen-fonts-venv. With the argument `ranges` it refreshes its snapshot of Google's CSS instead.

import * as fs from 'node:fs';
import { availableParallelism, homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import type { FontSlice } from '../../packages/lib/src/constants/font-slices';
import { FIRST_NON_ASCII, fontFaceCss } from '../../packages/lib/src/constants/font-slices';
import type { BundledFontFace, FallbackFont } from '../../packages/lib/src/constants/fonts';
import { FALLBACK_FONTS, FONT_FACES } from '../../packages/lib/src/constants/fonts';
import type { PublishedSubset, Slice } from './plan-slices';
import {
    CJK_KR_COVERAGE,
    CJK_SC_COVERAGE,
    closeSequences,
    emojiCoverage,
    formatRange,
    publishedSlices,
    rgiSequences,
    withRest,
} from './plan-slices';

const ROOT = path.join(import.meta.dir, '../..');
const FONTS_DIR = path.join(ROOT, 'packages/ui/src/assets/fonts');
const CSS_OUT = path.join(ROOT, 'packages/ui/src/styles/fonts.css');
// The Chinese and Korean faces, which the website leaves out: 55 of the 62 KB the rules take gzipped.
const CJK_CSS_OUT = path.join(ROOT, 'packages/ui/src/styles/fonts-cjk.css');
const CJK_FAMILIES = new Set(FALLBACK_FONTS.filter((font) => font.kind === 'cjk').map((font) => font.family));
const DATA_OUT = path.join(ROOT, 'packages/lib/src/constants/font-slice-data.gen.ts');
const SNAPSHOT = path.join(import.meta.dir, 'google-font-ranges.json');
const TOOL = path.join(import.meta.dir, 'font_tool.py');
const PYTHON = process.env.EIGEN_FONTS_PYTHON ?? path.join(homedir(), '.cache/eigen-fonts-venv/bin/python');
const CACHE = process.env.EIGEN_FONTS_CACHE ?? path.join(homedir(), '.cache/eigen-fonts-src/pinned');

// Google answers css2 by user agent, and only a recent Chrome gets WOFF2 with unicode-range for every family.
const USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const CSS2_QUERIES: Record<string, string> = {
    Inter: 'Inter:wght@100..900',
    'Source Serif 4': 'Source+Serif+4:ital,wght@0,200..900;1,200..900',
    'JetBrains Mono': 'JetBrains+Mono:ital,wght@0,100..800;1,100..800',
    'Noto Emoji': 'Noto+Emoji:wght@300..700',
    'Noto Sans SC': 'Noto+Sans+SC:wght@100..900',
    'Noto Sans KR': 'Noto+Sans+KR:wght@100..900',
};

type Source = { url: string; sha256: string };

const GOOGLE_FONTS = 'https://raw.githubusercontent.com/google/fonts/6c1dbe27dcf7d817d4b62cec033ba77fa8e2a5ec/ofl';
const UNICODE = 'https://www.unicode.org/Public/18.0.0';
const SOURCES = {
    notoEmoji: {
        url: `${GOOGLE_FONTS}/notoemoji/NotoEmoji%5Bwght%5D.ttf`,
        sha256: 'de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551',
    },
    notoEmojiLicense: {
        url: `${GOOGLE_FONTS}/notoemoji/OFL.txt`,
        sha256: '500bb1ccf43df7bbb522112f9133a52b16e1c35e809632f5d8609b179152de5b',
    },
    notoSansSc: {
        url: `${GOOGLE_FONTS}/notosanssc/NotoSansSC%5Bwght%5D.ttf`,
        sha256: 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da',
    },
    notoSansScLicense: {
        url: `${GOOGLE_FONTS}/notosanssc/OFL.txt`,
        sha256: '1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9',
    },
    notoSansKr: {
        url: `${GOOGLE_FONTS}/notosanskr/NotoSansKR%5Bwght%5D.ttf`,
        sha256: '194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252',
    },
    notoSansKrLicense: {
        url: `${GOOGLE_FONTS}/notosanskr/OFL.txt`,
        sha256: '1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9',
    },
    newComputerModern: {
        url: 'https://download.gnu.org.ua/release/newcm/newcm-8.1.1.txz',
        sha256: '1c10a9e2be6b0978a5d6e851094de72727237c1794ac200bc63604eb49adcba0',
    },
    gustLicense: {
        url: 'https://tug.org/fonts/licenses/GUST-FONT-LICENSE.txt',
        sha256: '49ea6cb9257bbee0a3979c48a774cd221550ac1c20c95549efe45fc99cc18050',
    },
    emojiData: {
        url: `${UNICODE}/ucd/emoji/emoji-data.txt`,
        sha256: '80d00f8e616a0ef27fd6b8de3b758c06383b5d917e2977709578e68baf733bf1',
    },
    emojiSequences: {
        url: `${UNICODE}/emoji/emoji-sequences.txt`,
        sha256: '1823dce71f3dd9cb0ad1976797baee4ffbdc1909756f43af8ce4c57f732843a4',
    },
    emojiZwjSequences: {
        url: `${UNICODE}/emoji/emoji-zwj-sequences.txt`,
        sha256: 'f61b5213bdf85a57741a9f903cb38d0f39a3d13be6ff4aca3b39857e859a9191',
    },
} satisfies Record<string, Source>;

// The math face inside the New Computer Modern release.
const MATH_MEMBER = 'newcm-8.1.1/otf/NewCMMath-Regular.otf';
const MATH_SHA256 = 'd66ac1cc91c55c24d3636ae2df1238076debdff51841f9893fc5419cc2df3df7';

// pyftsubset ignores a dropped feature after '*', so CJK lists its features. Both drop dlig, the discretionary
// ligatures CSS leaves off, which would pull whole ligature glyphs into every slice.
const ALL_FEATURES = ['*'];
const SC_FEATURES = 'aalt,ccmp,fwid,halt,hist,hwid,kern,liga,locl,mark,palt,pwid,ruby,vert,vhal,vkrn,vpal,vrt2';
const KR_FEATURES = `${SC_FEATURES},calt,ljmo,tjmo,vjmo`;

// The most a chunk of a face's rest may weigh, about one of Google's published slices for that kind of face. Korean's
// rest stays whole: it is the conjoining jamo, which compose an old Hangul syllable only inside one font.
const CJK_REST_BOUND = 60 * 1024;
const REST_BOUND = 40 * 1024;

type Snapshot = {
    fetched: string;
    userAgent: string;
    faces: Record<string, { query: string; subsets: PublishedSubset[] }>;
};

// One face as the script cuts it: its input font, the slices planned for it and how to cut them.
type Face = {
    kind: FallbackFont['kind'] | 'text';
    family: string;
    style: 'normal' | 'italic';
    weight: string;
    font: string;
    folder: string;
    base: string;
    slices: Slice[];
    features: string[];
    colorForeground: boolean;
    restBound: number;
};

if (process.argv[2] === 'ranges') await writeSnapshot();
else await build();

async function writeSnapshot(): Promise<void> {
    const faces: Snapshot['faces'] = {};
    for (const [family, query] of Object.entries(CSS2_QUERIES)) {
        const response = await fetch(`https://fonts.googleapis.com/css2?family=${query}`, {
            headers: { 'user-agent': USER_AGENT },
        });
        if (!response.ok) throw new Error(`css2 for ${family}: ${response.status}`);
        faces[family] = { query, subsets: parseGoogleCss(await response.text()) };
    }
    const snapshot: Snapshot = { fetched: new Date().toISOString().slice(0, 10), userAgent: USER_AGENT, faces };
    fs.writeFileSync(SNAPSHOT, JSON.stringify(snapshot));
    await formatAsTheRepo(SNAPSHOT);
    console.log(`wrote ${path.relative(ROOT, SNAPSHOT)}`);
}

// Each rule's subset name, style and range. A named subset ("latin") stands in a comment before its rule, and a
// numbered one ("119") in its file's name.
function parseGoogleCss(css: string): PublishedSubset[] {
    return [...css.matchAll(/(?:\/\*\s*([^*]*?)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g)].map((rule) => {
        const body = rule[2];
        const field = (name: string) => {
            const value = new RegExp(`${name}:\\s*([^;]+);`).exec(body)?.[1];
            if (value === undefined) throw new Error(`a css2 rule without ${name}`);
            return value.trim();
        };
        const label = /\.(\d+)\.woff2\)/.exec(body)?.[1] ?? rule[1];
        if (label === undefined) throw new Error('a css2 rule with no subset name');
        return { label, style: field('font-style'), unicodeRange: field('unicode-range') };
    });
}

async function build(): Promise<void> {
    const snapshot: Snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    const work = fs.mkdtempSync(path.join(tmpdir(), 'eigen-font-slices-'));
    fs.mkdirSync(CACHE, { recursive: true });

    // Each fallback claims its characters before the next one and before every text face, in registry order.
    const claimed = new Set<number>();
    const fallbacks: Face[] = [];
    for (const fallback of FALLBACK_FONTS) {
        const face = await planFallback(fallback, snapshot, work, claimed);
        fallbacks.push(face);
        if (fallback.kind === 'math') continue;
        // The keycap bases stay with the text faces too, so an emoji slice claims no ASCII.
        for (const slice of face.slices) {
            for (const codePoint of slice.codePoints) if (codePoint >= FIRST_NON_ASCII) claimed.add(codePoint);
        }
    }
    const textFaces = await Promise.all(FONT_FACES.map((face) => planTextFace(face, snapshot, claimed)));
    const faces = [...textFaces, ...fallbacks];

    for (const face of faces) clearSlices(face);
    await cutAll(faces, work);
    await chunkRests(faces, work);
    await writeLicenses();
    const slices = faces.flatMap((face) =>
        face.slices.map((slice): FontSlice => {
            const { family, style, weight } = face;
            return { family, style, weight, file: sliceFile(face, slice), unicodeRange: formatRange(slice.codePoints) };
        }),
    );
    fs.writeFileSync(CSS_OUT, fontsCss(slices.filter((slice) => !CJK_FAMILIES.has(slice.family))));
    fs.writeFileSync(CJK_CSS_OUT, fontsCss(slices.filter((slice) => CJK_FAMILIES.has(slice.family))));
    fs.writeFileSync(DATA_OUT, sliceData(slices));
    await formatAsTheRepo(CSS_OUT);
    await formatAsTheRepo(CJK_CSS_OUT);
    fs.rmSync(work, { recursive: true });
    report(faces);
}

async function planFallback(
    fallback: FallbackFont,
    snapshot: Snapshot,
    work: string,
    claimed: ReadonlySet<number>,
): Promise<Face> {
    if (fallback.family === 'Eigen Emoji') {
        const font = path.join(work, 'NotoEmoji-wght400-700.ttf');
        await python('instance', await source('notoEmoji'), font, 'wght=400:700');
        const cmap = await cmapOf(font);
        const coverage = emojiCoverage(fs.readFileSync(await source('emojiData'), 'utf8'));
        const published = publishedSlices(subsetsOf(snapshot, 'Noto Emoji', 'normal'), cmap, coverage, claimed);
        const sequenceFiles = [await source('emojiSequences'), await source('emojiZwjSequences')];
        const sequences = rgiSequences(
            sequenceFiles.map((file) => fs.readFileSync(file, 'utf8')),
            cmap,
            coverage,
        );
        const slices = closeSequences(published, sequences, coverage, cmap);
        return {
            kind: fallback.kind,
            family: fallback.family,
            style: 'normal',
            weight: '400 700',
            font,
            folder: 'noto-emoji',
            base: 'NotoEmoji',
            slices,
            features: ALL_FEATURES,
            colorForeground: true,
            restBound: REST_BOUND,
        };
    }
    if (fallback.family === 'Noto Sans SC' || fallback.family === 'Noto Sans KR') {
        const sc = fallback.family === 'Noto Sans SC';
        const font = await source(sc ? 'notoSansSc' : 'notoSansKr');
        const cmap = await cmapOf(font);
        const coverage = sc ? CJK_SC_COVERAGE : CJK_KR_COVERAGE;
        const slices = publishedSlices(subsetsOf(snapshot, fallback.family, 'normal'), cmap, coverage, claimed);
        return {
            kind: fallback.kind,
            family: fallback.family,
            style: 'normal',
            weight: '100 900',
            font,
            folder: sc ? 'noto-sans-sc' : 'noto-sans-kr',
            base: sc ? 'NotoSansSC' : 'NotoSansKR',
            slices: withRest(slices, cmap, coverage, claimed),
            features: (sc ? SC_FEATURES : KR_FEATURES).split(','),
            colorForeground: false,
            restBound: sc ? CJK_REST_BOUND : Number.POSITIVE_INFINITY,
        };
    }
    if (fallback.family === 'New Computer Modern Math') {
        // A formula's stretchy variants must sit in the face that lays it out, so the math face is one slice, whole.
        const font = await mathFont();
        return {
            kind: fallback.kind,
            family: fallback.family,
            style: 'normal',
            weight: '400',
            font,
            folder: 'new-computer-modern-math',
            base: 'NewCMMath-Regular',
            slices: [{ label: '', codePoints: await cmapOf(font) }],
            features: ALL_FEATURES,
            colorForeground: false,
            restBound: Number.POSITIVE_INFINITY,
        };
    }
    throw new Error(`no recipe for the fallback ${fallback.family}`);
}

// A text face is cut on Google's ranges for its family where Google serves it, and its upright ranges where Google
// has no italic, plus one slice for the characters no range holds, so the face draws all it drew whole.
async function planTextFace(face: BundledFontFace, snapshot: Snapshot, claimed: ReadonlySet<number>): Promise<Face> {
    const font = path.join(FONTS_DIR, face.file);
    const cmap = await cmapOf(font);
    const google = snapshot.faces[face.family];
    const style = google?.subsets.some((subset) => subset.style === face.style) ? face.style : 'normal';
    const slices = google ? publishedSlices(subsetsOf(snapshot, face.family, style), cmap, cmap, claimed) : [];
    const [folder, file] = face.file.split('/');
    return {
        kind: 'text',
        family: face.family,
        style: face.style,
        weight: face.weight,
        font,
        folder,
        base: file.replace(/\.woff2$/, ''),
        slices: withRest(slices, cmap, cmap, claimed),
        features: ALL_FEATURES,
        colorForeground: false,
        restBound: REST_BOUND,
    };
}

function subsetsOf(snapshot: Snapshot, family: string, style: string): PublishedSubset[] {
    const subsets = snapshot.faces[family]?.subsets.filter((subset) => subset.style === style) ?? [];
    if (subsets.length === 0) throw new Error(`the snapshot has no ${style} ranges for ${family}`);
    return subsets;
}

// The file of a slice, flat in its face's folder: Inter-Variable.latin.woff2, or the base alone for a face of one slice.
function sliceFile(face: Face, slice: Slice): string {
    return `${face.folder}/${face.base}${slice.label === '' ? '' : `.${slice.label}`}.woff2`;
}

// A rerun with fewer slices must not leave the old ones behind. A slice's name has its label between the face's name
// and .woff2, which the whole face has not.
function clearSlices(face: Face): void {
    const folder = path.join(FONTS_DIR, face.folder);
    fs.mkdirSync(folder, { recursive: true });
    for (const file of fs.readdirSync(folder)) {
        if (/^(.+)\.[^.]+\.woff2$/.exec(file)?.[1] === face.base) fs.rmSync(path.join(folder, file));
    }
}

// The math face is converted whole, its glyphs and tables untouched, since its license asks that a changed font be
// renamed. Every other slice is cut.
async function cutAll(faces: Face[], work: string): Promise<void> {
    const math = faces.find((face) => face.kind === 'math');
    if (math) await python('woff2', math.font, path.join(FONTS_DIR, sliceFile(math, math.slices[0])));
    const sliced = faces.filter((face) => face !== math);
    await cut(
        sliced.flatMap((face) =>
            face.slices.map((slice) =>
                cutJob(face, sorted(slice.codePoints), path.join(FONTS_DIR, sliceFile(face, slice))),
            ),
        ),
        work,
    );
}

// A rest heavier than its bound is cut in two halves of consecutive code points, and each half again until every chunk
// fits. Halves in code-point order keep a block such as the arrows in one chunk or two. The chunks replace the rest,
// numbered in that order.
async function chunkRests(faces: Face[], work: string): Promise<void> {
    type Chunk = { face: Face; codePoints: number[]; out: string };
    const heavy = (chunk: Chunk) => chunk.codePoints.length > 1 && fs.statSync(chunk.out).size > chunk.face.restBound;
    let splitting = faces.flatMap((face) =>
        face.slices
            .filter((slice) => slice.label === 'rest')
            .map((slice) => ({
                face,
                codePoints: sorted(slice.codePoints),
                out: path.join(FONTS_DIR, sliceFile(face, slice)),
            }))
            .filter(heavy),
    );
    const chunks: Chunk[] = [];
    while (splitting.length > 0) {
        const halves = splitting.flatMap(({ face, codePoints }) => {
            const middle = Math.ceil(codePoints.length / 2);
            return [codePoints.slice(0, middle), codePoints.slice(middle)].map((half) => ({
                face,
                codePoints: half,
                out: path.join(work, `${face.base}.${half[0]}-${half.length}.woff2`),
            }));
        });
        await cut(
            halves.map((half) => cutJob(half.face, half.codePoints, half.out)),
            work,
        );
        splitting = halves.filter(heavy);
        chunks.push(...halves.filter((half) => !heavy(half)));
    }
    for (const face of faces) {
        const own = chunks.filter((chunk) => chunk.face === face).sort((a, b) => a.codePoints[0] - b.codePoints[0]);
        if (own.length === 0) continue;
        const rest = face.slices.findIndex((slice) => slice.label === 'rest');
        fs.rmSync(path.join(FONTS_DIR, sliceFile(face, face.slices[rest])));
        const numbered = own.map((chunk, index) => {
            const slice = { label: `rest-${index + 1}`, codePoints: new Set(chunk.codePoints) };
            fs.copyFileSync(chunk.out, path.join(FONTS_DIR, sliceFile(face, slice)));
            return slice;
        });
        face.slices.splice(rest, 1, ...numbered);
    }
}

type CutJob = { font: string; codePoints: number[]; out: string; features: string[]; colorForeground: boolean };

function cutJob(face: Face, codePoints: number[], out: string): CutJob {
    return { font: face.font, codePoints, out, features: face.features, colorForeground: face.colorForeground };
}

function sorted(codePoints: ReadonlySet<number>): number[] {
    return [...codePoints].sort((a, b) => a - b);
}

// The jobs, many fonts at a time.
async function cut(jobs: CutJob[], work: string): Promise<void> {
    const workers = Math.max(1, availableParallelism() - 2);
    const batches = Array.from({ length: workers }, (_, worker) =>
        jobs.filter((_, index) => index % workers === worker),
    ).filter((batch) => batch.length > 0);
    await Promise.all(
        batches.map(async (batch, worker) => {
            const file = path.join(work, `jobs-${worker}.json`);
            fs.writeFileSync(file, JSON.stringify(batch));
            await python('subset', file);
        }),
    );
}

async function writeLicenses(): Promise<void> {
    const copies = [
        ['notoEmojiLicense', 'noto-emoji/OFL.txt'],
        ['notoSansScLicense', 'noto-sans-sc/OFL.txt'],
        ['notoSansKrLicense', 'noto-sans-kr/OFL.txt'],
        ['gustLicense', 'new-computer-modern-math/GUST-FONT-LICENSE.txt'],
    ] as const;
    for (const [key, file] of copies) fs.copyFileSync(await source(key), path.join(FONTS_DIR, file));
}

function fontsCss(slices: readonly FontSlice[]): string {
    const rules = slices.map((slice) => fontFaceCss(slice, `../assets/fonts/${slice.file}`));
    return `/* Generated by scripts/fonts/build-font-slices.ts: do not edit. Each rule is one slice of a bundled face. */

${rules.join('\n\n')}
`;
}

function sliceData(slices: readonly FontSlice[]): string {
    const rows = slices.map(
        (slice) =>
            `    { family: '${slice.family}', style: '${slice.style}', weight: '${slice.weight}', file: '${slice.file}', unicodeRange: '${slice.unicodeRange}' },`,
    );
    return `// Generated by scripts/fonts/build-font-slices.ts: do not edit. Each slice of a bundled face, as the font CSS loads it.

import type { FontSlice } from './font-slices';

export const FONT_SLICES: readonly FontSlice[] = [
${rows.join('\n')}
];
`;
}

function report(faces: Face[]): void {
    const byFamily = new Map<string, { slices: number; bytes: number }>();
    for (const face of faces) {
        const key = `${face.family} ${face.style}`;
        const total = byFamily.get(key) ?? { slices: 0, bytes: 0 };
        for (const slice of face.slices) {
            total.slices++;
            total.bytes += fs.statSync(path.join(FONTS_DIR, sliceFile(face, slice))).size;
        }
        byFamily.set(key, total);
    }
    for (const [family, { slices, bytes }] of byFamily) console.log(`${family}: ${slices} slices, ${bytes} bytes`);
    for (const file of [CSS_OUT, CJK_CSS_OUT]) {
        const css = fs.readFileSync(file);
        console.log(`${path.basename(file)}: ${css.length} bytes, ${Bun.gzipSync(css, { level: 9 }).length} gzipped`);
    }
}

// The math face sits in New Computer Modern's release archive.
async function mathFont(): Promise<string> {
    const font = path.join(CACHE, path.basename(MATH_MEMBER));
    if (!fs.existsSync(font) || sha256(font) !== MATH_SHA256) {
        const archive = await source('newComputerModern');
        const unpacked = fs.mkdtempSync(path.join(tmpdir(), 'eigen-newcm-'));
        await run(['tar', '-xJf', archive, '-C', unpacked, MATH_MEMBER]);
        fs.copyFileSync(path.join(unpacked, MATH_MEMBER), font);
        fs.rmSync(unpacked, { recursive: true });
    }
    if (sha256(font) !== MATH_SHA256) throw new Error(`${MATH_MEMBER} does not match its pinned SHA-256`);
    return font;
}

// A pinned download, fetched once into the cache and checked against its SHA-256 on every run.
async function source(key: keyof typeof SOURCES): Promise<string> {
    const pinned = SOURCES[key];
    const file = path.join(CACHE, `${pinned.sha256.slice(0, 12)}-${decodeURIComponent(path.basename(pinned.url))}`);
    if (!fs.existsSync(file)) {
        const response = await fetch(pinned.url);
        if (!response.ok) throw new Error(`${pinned.url}: ${response.status}`);
        fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    }
    if (sha256(file) !== pinned.sha256) throw new Error(`${file} does not match the SHA-256 pinned for ${pinned.url}`);
    return file;
}

// Biome wraps a long unicode-range its own way, so a generated file is formatted by it rather than by hand.
async function formatAsTheRepo(file: string): Promise<void> {
    await run(['bunx', 'biome', 'format', '--write', file]);
}

function sha256(file: string): string {
    return new Bun.CryptoHasher('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function cmapOf(font: string): Promise<Set<number>> {
    const codePoints: number[] = JSON.parse(await python('cmap', font));
    return new Set(codePoints);
}

function python(...args: string[]): Promise<string> {
    return run([PYTHON, '-I', TOOL, ...args]);
}

async function run(command: string[]): Promise<string> {
    const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    if (code !== 0) throw new Error(`${command.slice(0, 4).join(' ')} failed:\n${stderr}`);
    return stdout;
}
