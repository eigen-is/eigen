// Ratchet the mechanical CODE-STANDARDS rules that Biome can't express.
//
// Two kinds of metric: hard zeros (any hit fails) and ratcheted counts, whose allowance lives in
// scripts/standards-baseline.json. A count may never rise; `--update` rewrites the baseline down to
// what the tree actually has. `--verbose` prints the per-file breakdown. See docs/CODE-STANDARDS.md.

const BASELINE_PATH = 'scripts/standards-baseline.json';

const verbose = process.argv.includes('--verbose');
const update = process.argv.includes('--update');

// Non-test, non-generated source. packages/sheet is a fork with its own conventions.
function inScope(path: string): boolean {
    if (!/\.tsx?$/.test(path)) return false;
    if (path.startsWith('packages/sheet/')) return false;
    if (path.includes('/src/test/')) return false;
    return !(path.endsWith('.d.ts') || /\.test\.tsx?$/.test(path) || path.endsWith('routeTree.gen.ts'));
}

// A `<` opens a JSX element only where an expression may start — after an operator, an opener or a
// keyword. After an expression (identifier, `)`, `]`, literal) it is a comparison or a generic argument
// list instead. `<T,>` and `<T extends …>` are the two generic forms .tsx still allows in that position.
const JSX_ELEMENT_START = /(?:[([{=,:?;!+&|]|=>|&&|\|\||\b(?:return|yield|await|case|in|of|else|do))\s*$/;
const JSX_TAG_OPEN = /^<(?:>|[A-Za-z][\w.:-]*\s*(?!,|extends\b))/;
// Children are blanked only while they read as prose. Anything code-shaped means the `<` was misread —
// a regex body spells `<p>` too — and blanking on it would hide the very casts the gate counts.
const JSX_TEXT = /^[^;=()[\]"`\\|]*$/;

// Blanks out comment bodies, literal contents and JSX text so identifier-shaped metrics never fire on
// prose ("treat it as a secret") or on a string that happens to spell a keyword. Line count is preserved.
// JSX needs its own mode because a text child is neither a comment nor a literal: `mode` tracks whether
// we sit in code, between a tag's angle brackets, or in element children, and `{…}` in the latter two
// pushes code back on. Only .tsx is scanned that way — in .ts every `<` is a comparison or a generic.
function stripNoise(source: string, tsx = false): string {
    let out = '';
    let index = 0;
    const modes: ('code' | 'tag' | 'jsx')[] = ['code'];
    const depths = [0];
    while (index < source.length) {
        const char = source[index];
        const mode = modes[modes.length - 1];
        if (mode === 'jsx') {
            if (char === '{') {
                modes.push('code');
                depths.push(0);
                out += char;
                index++;
            } else if (char === '<' && source[index + 1] === '/') {
                const end = source.indexOf('>', index);
                const stop = end < 0 ? source.length : end + 1;
                out += source.slice(index, stop).replaceAll(/[^\n]/g, ' ');
                index = stop;
                modes.pop();
                depths.pop();
            } else if (char === '<' && JSX_TAG_OPEN.test(source.slice(index, index + 40))) {
                modes.push('tag');
                depths.push(0);
                out += char;
                index++;
            } else {
                let end = index + 1;
                while (end < source.length && source[end] !== '{' && source[end] !== '<') end++;
                const run = source.slice(index, end);
                out += JSX_TEXT.test(run) ? run.replaceAll(/[^\n]/g, ' ') : run;
                index = end;
            }
        } else if (char === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
            const end = source[index + 1] === '/' ? source.indexOf('\n', index) : source.indexOf('*/', index + 2) + 2;
            const stop = end <= index ? source.length : end;
            out += source.slice(index, stop).replaceAll(/[^\n]/g, ' ');
            index = stop;
        } else if (char === "'" || char === '"' || char === '`') {
            out += char;
            index++;
            while (index < source.length && source[index] !== char) {
                if (source[index] === '\\') index++;
                else if (source[index] === '\n') out += '\n';
                index++;
            }
            out += char;
            index++;
        } else {
            if (char === '{') {
                if (mode === 'tag') {
                    modes.push('code');
                    depths.push(0);
                } else depths[depths.length - 1]++;
            } else if (char === '}' && mode === 'code') {
                if (depths[depths.length - 1] > 0) depths[depths.length - 1]--;
                else if (modes.length > 1) {
                    modes.pop();
                    depths.pop();
                }
            } else if (mode === 'tag' && char === '>') {
                modes.pop();
                depths.pop();
                if (source[index - 1] !== '/') {
                    modes.push('jsx');
                    depths.push(0);
                }
            } else if (
                tsx &&
                mode === 'code' &&
                char === '<' &&
                JSX_TAG_OPEN.test(source.slice(index, index + 40)) &&
                JSX_ELEMENT_START.test(out.slice(-24).trimEnd())
            ) {
                modes.push('tag');
                depths.push(0);
            }
            out += char;
            index++;
        }
    }
    return out;
}

// `as` also renames in module statements, so drop those before counting casts.
// Specifiers are already blanked to '' by stripNoise; a module statement holds no `;` or `=`.
const MODULE_STATEMENT =
    /(?:^|\n)[ \t]*(?:import|export)\b[^;=]*?from[ \t]*(?:''|"")|(?:^|\n)[ \t]*import[ \t]*(?:''|"")|(?:^|\n)[ \t]*export[ \t]*\{[^}=;]*\}/g;
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

const ROUTE_FILE = /^apps\/api\/src\/routes\/[^/]+\.ts$/;
// The home-independent surfaces that deliberately carry no `:ownerId` (docs/ARCHITECTURE.md § Pitfalls):
// first-run setup, server-wide admin config, the unauthenticated public surface, and the admin backup
// routes — server-wide too, gated by `requireAdmin` in every handler rather than by home ownership.
const OWNER_ID_EXEMPT = new Set(['setup.ts', 'settings.ts', 'waitlist.ts', 'public.ts', 'backup.ts']);
// One chunk per route: from its `.method('/…` to the next one.
const ROUTE_START = /\.(?:get|post|put|patch|delete|ws|head|options|all)\(\s*['"]\//;
// `/ws` is a transport prefix rather than a path segment — the collab socket's `:ownerId` sits behind it.
const TRANSPORT_PREFIX = /^\/ws(?=\/)/;

// docs/LAYOUT.md § Hover-Only Icons: an affordance hidden until hover must rest visible on touch, which has
// no hover. Only a hidden element is at risk — a decorative `group-hover:scale-105` reveals nothing —
// so the trigger is a hiding utility plus a revealing `group-hover:` in the same class string.
// `pointer-fine:group-hover:` declares the hover desktop-only on purpose and is not a gap.
const STRING_LITERAL = /'[^'\n]*'|"[^"\n]*"|`[^`]*`/g;
const HIDDEN_BASE = /(?<![\w-])(?:invisible|hidden|opacity-0)(?![\w-])/;
const HOVER_REVEAL =
    /(?<!pointer-fine:)\bgroup-hover:(visible|flex|grid|block|inline-flex|inline-block|opacity-\d+)(?![\w-])/g;

type SourceFile = {
    path: string;
    // Raw file text — use it for anything that lives in a comment, a string, or a class name.
    text: string;
    // Comments and literal contents blanked out — use it for anything identifier-shaped.
    code: string;
};

type Metric = {
    id: string;
    label: string;
    hardZero: boolean;
    count: (file: SourceFile) => number;
};

function countMatches(source: string, pattern: RegExp): number {
    return source.match(pattern)?.length ?? 0;
}

const METRICS: Metric[] = [
    {
        id: 'as-casts',
        label: '`as Type` casts',
        hardZero: false,
        // `as unknown as T` is one escape hatch, not two.
        count: ({ code }) =>
            countMatches(
                code.replaceAll(MODULE_STATEMENT, '').replaceAll(/\bas\s+unknown\s+as\b/g, 'as'),
                /\bas\s+(?!const\b)/g,
            ),
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
        label: 'Raw Tailwind colour utilities',
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

const paths = (await Bun.$`git ls-files apps packages`.text()).split('\n').filter(inScope);

const counts = new Map<string, number>(METRICS.map((metric) => [metric.id, 0]));
const breakdown = new Map<string, Map<string, number>>(METRICS.map((metric) => [metric.id, new Map()]));

for (const path of paths) {
    const text = await Bun.file(path).text();
    const file: SourceFile = { path, text, code: stripNoise(text, path.endsWith('.tsx')) };
    for (const metric of METRICS) {
        const hits = metric.count(file);
        if (hits === 0) continue;
        counts.set(metric.id, (counts.get(metric.id) ?? 0) + hits);
        breakdown.get(metric.id)?.set(path, hits);
    }
}

const baselineFile = Bun.file(BASELINE_PATH);
const baseline: Record<string, number> = (await baselineFile.exists()) ? await baselineFile.json() : {};

if (update) {
    const next: Record<string, number> = {};
    for (const metric of METRICS) {
        if (metric.hardZero) continue;
        const current = counts.get(metric.id) ?? 0;
        next[metric.id] = metric.id in baseline ? Math.min(current, baseline[metric.id]) : current;
    }
    await Bun.write(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    Object.assign(baseline, next);
    console.log(`Updated ${BASELINE_PATH}\n`);
}

const width = Math.max(...METRICS.map((metric) => metric.label.length));
const failed: Metric[] = [];

console.log(`${'metric'.padEnd(width)}  count  baseline`);
for (const metric of METRICS) {
    const count = counts.get(metric.id) ?? 0;
    const allowed = metric.hardZero ? 0 : (baseline[metric.id] ?? 0);
    if (count > allowed) failed.push(metric);
    const status = count > allowed ? '  OVER' : count < allowed ? '  under baseline' : '';
    console.log(
        `${metric.label.padEnd(width)}  ${String(count).padStart(5)}  ${metric.hardZero ? '    zero' : String(allowed).padStart(8)}${status}`,
    );
    if (!verbose) continue;
    for (const [path, hits] of [...(breakdown.get(metric.id) ?? [])].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${String(hits).padStart(4)}  ${path}`);
    }
}

if (failed.length === 0) process.exit(0);

console.error('\nERROR: code-standards gate exceeded\n');
for (const metric of failed) {
    console.error(
        `  ${metric.label}: ${counts.get(metric.id)} allowed ${metric.hardZero ? 0 : (baseline[metric.id] ?? 0)}`,
    );
    for (const [path, hits] of [...(breakdown.get(metric.id) ?? [])].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
        console.error(`      ${String(hits).padStart(4)}  ${path}`);
    }
}
console.error('\nSee docs/CODE-STANDARDS.md § Standards gates. Run with --verbose for the full breakdown.');
process.exit(1);
