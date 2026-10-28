// Counts the mechanical code standards that Biome can't express, over apps and packages, for `bun run check`. A hard
// zero fails on any hit. A ratcheted count fails when it rises above its allowance in the baseline file: one total, or
// for casts and `!` one allowance per file, so a new one can't hide behind a removal elsewhere. Every run lowers an
// allowance to a count that fell, so a cleanup needs no second step. `--verbose` prints each file's counts.

import { sentenceCaseHits } from './sentence-case';
import { stripNoise } from './strip-noise';
import type { ExportsMaps, Primitive, SourceFile } from './unused-primitives';
import { readPrimitivesIndex, unusedPrimitives } from './unused-primitives';

const BASELINE_PATH = 'scripts/standards-baseline.json';

const verbose = process.argv.includes('--verbose');

// Non-test, non-generated source. The sheet grammar parser is jison output (biome skips it too).
const GENERATED = ['routeTree.gen.ts', 'packages/sheet/src/engine/parser/grammar-parser/grammar-parser.ts'];
function inScope(path: string): boolean {
    if (!/\.tsx?$/.test(path)) return false;
    if (path.includes('/src/test/')) return false;
    return !(path.endsWith('.d.ts') || /\.test\.tsx?$/.test(path) || GENERATED.some((tail) => path.endsWith(tail)));
}

// `as` also renames in module statements, so drop those before counting casts.
// stripNoise blanks a specifier's contents, so it reads as quotes around spaces; a module statement
// holds no `;` or `=`.
const MODULE_STATEMENT =
    /(?:^|\n)[ \t]*(?:import|export)\b[^;=]*?from[ \t]*(?:'[^'\n]*'|"[^"\n]*")|(?:^|\n)[ \t]*import[ \t]*(?:'[^'\n]*'|"[^"\n]*")|(?:^|\n)[ \t]*export[ \t]*\{[^}=;]*\}/g;
const DEEP_IMPORT = /@workspace\/(?:lib\/core\/|lib\/src\/|ui\/src\/)|['"]@workspace\/[\w@./-]+\.tsx?['"]/g;
// Tailwind's default palette — theme tokens replace every one of these (CODE-STANDARDS § Code Style).
const PALETTE =
    'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const RAW_COLOR = new RegExp(
    `\\b(?:text|bg|border|ring|fill|stroke|from|via|to|divide|outline|decoration|accent|caret|placeholder|shadow)-(?:${PALETTE})-(?:50|\\d00|950)\\b`,
    'g',
);
const APP_LAYER = /\b(?:useQuery|useMutation|useInfiniteQuery)\(|\btoast\.(?:error|success)\(/g;

// Every Eigen document MIME, read from the one file that declares them so a seventh type never needs a
// second list here. `application/eigen-*` — the drag and clipboard wire formats — is a different family,
// not a document MIME, hence the `(?!-)`.
const MIME_SOURCE = 'packages/lib/src/types/drive.ts';
const EIGEN_MIME = /application\/eigen(?!-)[a-z]*/g;
const CANONICAL_MIMES = new Set(
    [...(await Bun.file(MIME_SOURCE).text()).matchAll(/DRIVE_MIME_\w+ = '(application\/eigen[a-z]*)'/g)].map(
        (match) => match[1],
    ),
);
if (CANONICAL_MIMES.size === 0) {
    console.error(`ERROR: no DRIVE_MIME_* constants found in ${MIME_SOURCE} — the mime gate has nothing to check`);
    process.exit(1);
}

// CODE-STANDARDS § Standards Gates: a primitive the shared-primitives index lists needs a user outside its file. The
// unused ones are found once, from every source file, before the per-file counts, and each counts against the file
// that defines it.
const PRIMITIVES_INDEX = 'docs/SHARED-PRIMITIVES.md';
const unusedByFile = new Map<string, Primitive[]>();

function unusedIn(path: string, isType: boolean): number {
    return (unusedByFile.get(path) ?? []).filter((primitive) => primitive.isType === isType).length;
}

const ROUTE_FILE = /^apps\/api\/src\/routes\/[^/]+\.ts$/;
// The home-independent surfaces that deliberately carry no `:ownerId` (docs/ARCHITECTURE.md § Pitfalls):
// first-run setup, server-wide admin config, the unauthenticated public surface, and the backup routes,
// server-wide too: `backup.ts` gated by `requireAdmin` in every handler, `server-backup.ts` by `requireOwner`.
const OWNER_ID_EXEMPT = new Set([
    'setup.ts',
    'settings.ts',
    'waitlist.ts',
    'public.ts',
    'backup.ts',
    'server-backup.ts',
]);
// One chunk per route: from its `.method('/…` to the next one.
const ROUTE_START = /\.(?:get|post|put|patch|delete|ws|head|options|all)\(\s*['"]\//;
// `/ws` is a transport prefix rather than a path segment — the collab socket's `:ownerId` sits behind it.
const TRANSPORT_PREFIX = /^\/ws(?=\/)/;

// docs/LAYOUT.md § Hover-revealed affordances rest visible on touch: an affordance hidden until hover must
// rest visible on touch, which has no hover. Only a hidden element is at risk — a decorative
// `group-hover:scale-105` reveals nothing — so the trigger is a hiding utility plus a revealing
// `group-hover:` in the same class string.
// `pointer-fine:group-hover:` declares the hover desktop-only on purpose and is not a gap.
const STRING_LITERAL = /'[^'\n]*'|"[^"\n]*"|`[^`]*`/g;
const HIDDEN_BASE = /(?<![\w-])(?:invisible|hidden|opacity-0)(?![\w-])/;
const HOVER_REVEAL =
    /(?<!pointer-fine:)\bgroup-hover:(visible|flex|grid|block|inline-flex|inline-block|opacity-\d+)(?![\w-])/g;

// docs/LAYOUT.md § A row that deletes is red and last: a row that deletes, trashes or removes is the destructive
// variant, red with its icon, never a plain row or one tinted by a class. A row is destructive when it draws a trash
// icon or its label (JSX text or a string literal, read where stripNoise blanked it) says Delete, Remove or to trash. A
// toggle's label, a ternary with one branch saying Remove and the other not ('Remove' : 'Add', say), names an
// undo, not a deletion.
const MENU_ROW = /<(DropdownMenuItem|SelectItem)\b/g;
const TRASH_ICON = /<Trash2?\b/;
const DESTRUCTIVE_LABEL = /\b(?:Delete|Remove)\b|\bto trash\b/;
const DESTRUCTIVE_VARIANT = /\bvariant=(?:["']destructive["']|\{[^}]*destructive)/;
const TERNARY_LABELS = /\?\s*(['"`])([^'"`\n]*)\1\s*:\s*(['"`])([^'"`\n]*)\3/g;

// Where the opening tag that starts at `start` ends: the first `>` outside braces and quotes.
function openingTagEnd(text: string, start: number): number {
    let depth = 0;
    let quote = '';
    for (let i = start; i < text.length; i++) {
        const char = text[i];
        if (quote) {
            if (char === quote) quote = '';
        } else if (char === '"' || char === "'" || char === '`') quote = char;
        else if (char === '{') depth++;
        else if (char === '}') depth--;
        else if (char === '>' && depth === 0) return i;
    }
    return text.length;
}

function plainDestructiveRows({ text, code }: SourceFile): number {
    let hits = 0;
    for (const match of text.matchAll(MENU_ROW)) {
        const tagEnd = openingTagEnd(text, match.index);
        const openingTag = text.slice(match.index, tagEnd + 1);
        if (DESTRUCTIVE_VARIANT.test(openingTag)) continue;
        if (/\btext-destructive\b/.test(openingTag)) {
            hits++;
            continue;
        }
        if (openingTag.endsWith('/>')) continue;
        const close = text.indexOf(`</${match[1]}>`, tagEnd);
        const end = close === -1 ? text.length : close;
        const content = text
            .slice(0, end)
            .replaceAll(TERNARY_LABELS, (ternary, _q, yes: string, _q2, no: string) =>
                DESTRUCTIVE_LABEL.test(yes) === DESTRUCTIVE_LABEL.test(no) ? ternary : ' '.repeat(ternary.length),
            );
        let literal = '';
        for (let i = tagEnd + 1; i < end; i++) literal += code[i] === content[i] ? ' ' : content[i];
        if (TRASH_ICON.test(code.slice(tagEnd + 1, end)) || DESTRUCTIVE_LABEL.test(literal)) hits++;
    }
    return hits;
}

// docs/LAYOUT.md § A choice is a submenu with a check: a menu row shows a current option or an on state with the check
// ChoiceMenuItems and DropdownMenuCheckboxItem draw, never a Check it draws itself when a condition holds. The color
// picker's swatch grid marks its color inside the swatch, as Google's palette does.
const DRAWN_CHECK = /(?:&&|\?)\s*\(?\s*<Check(?:Icon)?\b/;
const SWATCH_GRID = 'packages/ui/src/components/media/color-picker-menu-item.tsx';

function handDrawnMenuChecks({ path, code }: SourceFile): number {
    if (path === SWATCH_GRID) return 0;
    let hits = 0;
    for (const match of code.matchAll(/<DropdownMenuItem\b/g)) {
        const tagEnd = openingTagEnd(code, match.index);
        const close = code.indexOf('</DropdownMenuItem>', tagEnd);
        if (DRAWN_CHECK.test(code.slice(tagEnd + 1, close === -1 ? code.length : close))) hits++;
    }
    return hits;
}

type Metric = {
    id: string;
    label: string;
    hardZero: boolean;
    // Ratcheted per file: a file without an allowance is allowed none.
    perFile?: true;
    count: (file: SourceFile) => number;
};

function countMatches(source: string, pattern: RegExp): number {
    return source.match(pattern)?.length ?? 0;
}

function sum(values: number[]): number {
    return values.reduce((total, value) => total + value, 0);
}

const METRICS: Metric[] = [
    {
        id: 'as-casts',
        label: '`as Type` casts',
        hardZero: false,
        perFile: true,
        // `as unknown as T` is one escape hatch, not two.
        count: ({ code }) =>
            countMatches(
                code.replaceAll(MODULE_STATEMENT, '').replaceAll(/\bas\s+unknown\s+as\b/g, 'as'),
                /\bas\s+(?!const\b)/g,
            ),
    },
    {
        id: 'non-null-assertions',
        label: '`!` non-null assertions',
        hardZero: false,
        perFile: true,
        // A postfix `!` after a name, a call or an index, not the start of `!=`; `let x!: T` counts too.
        count: ({ code }) => countMatches(code, /[\w$)\]]!(?!=)/g),
    },
    {
        id: 'interface-decls',
        label: '`interface` declarations',
        hardZero: false,
        // Module augmentation only merges through interfaces, so those don't count.
        count: ({ code }) => {
            let depth = 0;
            let augmenting = 0;
            let hits = 0;
            for (const line of code.split('\n')) {
                if (augmenting === 0 && /^\s*declare\s+module\b/.test(line)) augmenting = depth + 1;
                else if (augmenting === 0 && /^\s*(?:export\s+)?(?:declare\s+)?interface\s/.test(line)) hits++;
                depth += countMatches(line, /\{/g) - countMatches(line, /\}/g);
                if (augmenting > 0 && depth < augmenting) augmenting = 0;
            }
            return hits;
        },
    },
    {
        id: 'biome-ignore',
        label: '`biome-ignore` suppressions',
        hardZero: false,
        count: ({ text }) => countMatches(text, /biome-ignore/g),
    },
    {
        id: 'jsdoc-blocks',
        label: 'JSDoc blocks',
        hardZero: false,
        count: ({ text }) => countMatches(text, /^[ \t]*\/\*\*/gm),
    },
    {
        id: 'raw-colors',
        label: 'Raw Tailwind color utilities',
        hardZero: false,
        count: ({ path, text }) => (path.endsWith('.tsx') ? countMatches(text, RAW_COLOR) : 0),
    },
    {
        id: 'use-client',
        label: '`"use client"` directives',
        hardZero: true,
        count: ({ text }) => countMatches(text, /^\s*['"]use client['"]/gm),
    },
    {
        id: 'deep-imports',
        label: 'Imports reaching past a package barrel',
        hardZero: true,
        count: ({ text }) => countMatches(text, DEEP_IMPORT),
    },
    {
        id: 'barrel-type-exports',
        label: 'Type re-exports from a lib core barrel',
        hardZero: true,
        count: ({ path, code }) =>
            /^packages\/lib\/src\/core\/.*index\.ts$/.test(path) ? countMatches(code, /^\s*export\s+type\b/gm) : 0,
    },
    {
        id: 'app-layer',
        label: 'Query/mutation/toast calls in app components',
        hardZero: true,
        // Data fetching and error toasts belong in packages/lib hooks, never in an app component.
        count: ({ path, code }) =>
            /^apps\/(?!api\/)[^/]+\/src\//.test(path) && !path.includes('/hooks/') ? countMatches(code, APP_LAYER) : 0,
    },
    {
        id: 'wrong-eigen-mime',
        label: 'Non-canonical `application/eigen…` MIMEs',
        hardZero: true,
        // `eigenslide` for `eigenslides` and `eigensheet` for `eigensheets` are the typos this catches.
        count: ({ text }) => (text.match(EIGEN_MIME) ?? []).filter((mime) => !CANONICAL_MIMES.has(mime)).length,
    },
    {
        id: 'route-owner-id',
        label: 'Authenticated routes without `:ownerId` second',
        hardZero: true,
        // `ownerId` names the Home that owns the resource, which is the future sharding key.
        count: ({ path, text }) => {
            if (!ROUTE_FILE.test(path) || OWNER_ID_EXEMPT.has(path.slice(path.lastIndexOf('/') + 1))) return 0;
            let hits = 0;
            for (const chunk of text.split(new RegExp(`(?=${ROUTE_START.source})`)).slice(1)) {
                const route = /['"](\/[^'"]*)['"]/.exec(chunk)?.[1];
                // `auth: true` is this route's own option object; an unauthenticated route (LMTP
                // delivery, guest OTP) answers to no Home and is skipped. Comments don't count.
                if (route === undefined || !/auth:\s*true/.test(stripNoise(chunk))) continue;
                if (route.replace(TRANSPORT_PREFIX, '').split('/')[2] !== ':ownerId') hits++;
            }
            return hits;
        },
    },
    {
        id: 'plain-destructive-rows',
        label: 'Delete or remove menu rows without the destructive variant',
        hardZero: true,
        count: (file) => (file.path.endsWith('.tsx') ? plainDestructiveRows(file) : 0),
    },
    {
        id: 'hand-drawn-menu-checks',
        label: 'Menu rows drawing their own check',
        hardZero: true,
        count: (file) => (file.path.endsWith('.tsx') ? handDrawnMenuChecks(file) : 0),
    },
    {
        id: 'sentence-case',
        label: 'Capitalized words in UI labels',
        hardZero: true,
        // CODE-STANDARDS § UI labels are sentence case; the proper-noun list lives in sentence-case.ts.
        count: ({ path, text }) => sentenceCaseHits(path, text).length,
    },
    {
        id: 'unused-primitives',
        label: 'Shared primitives nothing imports',
        hardZero: true,
        count: ({ path }) => unusedIn(path, false),
    },
    {
        id: 'unused-primitive-types',
        label: 'Shared types nothing imports',
        hardZero: false,
        count: ({ path }) => unusedIn(path, true),
    },
    {
        id: 'hover-without-touch',
        label: 'Hover-revealed affordances without touch',
        hardZero: true,
        count: ({ text }) => {
            let hits = 0;
            for (const literal of text.match(STRING_LITERAL) ?? []) {
                if (!HIDDEN_BASE.test(literal)) continue;
                for (const [, utility] of literal.matchAll(HOVER_REVEAL)) {
                    if (!text.includes(`pointer-coarse:${utility}`)) hits++;
                }
            }
            return hits;
        },
    },
];

// Every source file, tests and scripts included, since any of them may use a primitive. The metrics count in the
// non-test sources of apps and packages.
const sources: SourceFile[] = [];
for (const path of (await Bun.$`git ls-files apps packages scripts docker`.text()).split('\n')) {
    if (!/\.(?:ts|tsx|js|jsx|mjs)$/.test(path) || GENERATED.some((tail) => path.endsWith(tail))) continue;
    const text = await Bun.file(path).text();
    sources.push({ path, text, code: stripNoise(text, path.endsWith('x')) });
}

const exportsMaps: ExportsMaps = {};
for (const manifest of (await Bun.$`git ls-files 'packages/*/package.json'`.text()).split('\n').filter(Boolean)) {
    exportsMaps[manifest.split('/')[1]] = (await Bun.file(manifest).json()).exports ?? {};
}
const primitives = unusedPrimitives(readPrimitivesIndex(await Bun.file(PRIMITIVES_INDEX).text()), sources, exportsMaps);
for (const primitive of primitives.unused) {
    unusedByFile.set(primitive.file, [...(unusedByFile.get(primitive.file) ?? []), primitive]);
}

const counts = new Map<string, number>(METRICS.map((metric) => [metric.id, 0]));
const breakdown = new Map<string, Map<string, number>>(METRICS.map((metric) => [metric.id, new Map()]));

for (const file of sources) {
    const { path } = file;
    if (!/^(?:apps|packages)\//.test(path) || !inScope(path)) continue;
    for (const metric of METRICS) {
        const hits = metric.count(file);
        if (hits === 0) continue;
        counts.set(metric.id, (counts.get(metric.id) ?? 0) + hits);
        breakdown.get(metric.id)?.set(path, hits);
    }
}

type Allowance = number | Record<string, number>;

const baselineFile = Bun.file(BASELINE_PATH);
const baseline: Record<string, Allowance> = (await baselineFile.exists()) ? await baselineFile.json() : {};

// What one file may hold of a metric: its own entry when the metric is per file, else the total.
function allowedIn(metric: Metric, allowance: Allowance | undefined, path: string): number {
    if (metric.hardZero) return 0;
    if (typeof allowance === 'object') return allowance[path] ?? 0;
    return allowance ?? 0;
}

// A ratcheted count that fell becomes the new baseline; one that rose keeps the old one and fails below. A metric with
// no entry yet starts at today's count. A file over its allowance keeps it, so the failure below still names it, and
// the entry of a file that holds none, or that is gone, drops.
const next: Record<string, Allowance> = {};
for (const metric of METRICS) {
    if (metric.hardZero) continue;
    const previous = baseline[metric.id];
    if (!metric.perFile) {
        const current = counts.get(metric.id) ?? 0;
        next[metric.id] = typeof previous === 'number' ? Math.min(current, previous) : current;
        continue;
    }
    const files: Record<string, number> = {};
    for (const [path, hits] of [...(breakdown.get(metric.id) ?? [])].sort((a, b) => a[0].localeCompare(b[0]))) {
        const allowed = typeof previous === 'object' ? (previous[path] ?? 0) : hits;
        if (Math.min(hits, allowed) > 0) files[path] = Math.min(hits, allowed);
    }
    next[metric.id] = files;
}
if (JSON.stringify(next) !== JSON.stringify(baseline)) {
    await Bun.write(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    for (const metric of METRICS) {
        if (metric.hardZero) continue;
        const before = baseline[metric.id];
        const after = next[metric.id];
        if (typeof after === 'number') {
            if (after !== before) console.log(`${BASELINE_PATH}: ${metric.id} ${before ?? 'new'} → ${after}`);
            continue;
        }
        for (const path of new Set([...Object.keys(typeof before === 'object' ? before : {}), ...Object.keys(after)])) {
            const was = typeof before === 'object' ? (before[path] ?? 0) : 'new';
            if (was !== (after[path] ?? 0))
                console.log(`${BASELINE_PATH}: ${metric.id} ${path} ${was} → ${after[path] ?? 0}`);
        }
    }
    Object.assign(baseline, next);
    console.log('Commit the lowered baseline with the change that lowered it.\n');
}

const width = Math.max(...METRICS.map((metric) => metric.label.length));
const failed: Metric[] = [];
// The files that hold more than they are allowed, per metric.
const over = new Map<string, [string, number, number][]>();

console.log(`${'metric'.padEnd(width)}  count  baseline`);
for (const metric of METRICS) {
    const count = counts.get(metric.id) ?? 0;
    const allowance = baseline[metric.id];
    const allowed = metric.hardZero
        ? 0
        : typeof allowance === 'object'
          ? sum(Object.values(allowance))
          : (allowance ?? 0);
    const files = metric.perFile
        ? [...(breakdown.get(metric.id) ?? [])]
              .map(([path, hits]): [string, number, number] => [path, hits, allowedIn(metric, allowance, path)])
              .filter(([, hits, fileAllowed]) => hits > fileAllowed)
        : [];
    if (files.length > 0) over.set(metric.id, files);
    const exceeded = metric.perFile ? files.length > 0 : count > allowed;
    if (exceeded) failed.push(metric);
    console.log(
        `${metric.label.padEnd(width)}  ${String(count).padStart(5)}  ${metric.hardZero ? '    zero' : String(allowed).padStart(8)}${exceeded ? '  OVER' : ''}`,
    );
    if (!verbose) continue;
    for (const [path, hits] of [...(breakdown.get(metric.id) ?? [])].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${String(hits).padStart(4)}  ${path}`);
    }
}

// The primitives behind the two counts by name. Those only tests import are reported, not gated: many are pure helpers
// that production reaches through a wrapper, tested on their own.
for (const primitive of primitives.unused) console.log(`  unused: ${primitive.name} (${primitive.file})`);
console.log(
    `\n${primitives.testOnly.length} shared primitives only tests import${verbose ? ':' : ', --verbose lists them'}`,
);
if (verbose) for (const primitive of primitives.testOnly) console.log(`    ${primitive.name} (${primitive.file})`);

if (failed.length === 0) process.exit(0);

console.error('\nERROR: code-standards gate exceeded\n');
for (const metric of failed) {
    const files = over.get(metric.id);
    if (files) {
        console.error(`  ${metric.label}, per file:`);
        for (const [path, hits, allowed] of files) console.error(`      ${path}: ${hits} allowed ${allowed}`);
        continue;
    }
    console.error(
        `  ${metric.label}: ${counts.get(metric.id)} allowed ${metric.hardZero ? 0 : (baseline[metric.id] ?? 0)}`,
    );
    for (const [path, hits] of [...(breakdown.get(metric.id) ?? [])].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
        console.error(`      ${String(hits).padStart(4)}  ${path}`);
    }
}
console.error('\nSee docs/CODE-STANDARDS.md § Standards gates. Run with --verbose for the full breakdown.');
process.exit(1);
